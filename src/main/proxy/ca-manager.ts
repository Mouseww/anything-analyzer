import * as forge from "node-forge";
import * as tls from "tls";
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "fs";
import { join } from "path";

const CA_KEY_FILE = "ca-key.pem";
const CA_CERT_FILE = "ca-cert.pem";
const CA_VALIDITY_YEARS = 10;
// Chrome / Chromium / Firefox / iOS / Android 自 2020-09 起统一上限 398 天。
// 825 是 Apple 历史值，已不被任何现代浏览器接受（Android Chrome 直接报 ERR_CERT_VALIDITY_TOO_LONG）。
// 留 33 天缓冲避免边界期 cert 被拒。
const LEAF_VALIDITY_DAYS = 365;
const CACHE_MAX_SIZE = 500;

/**
 * CaManager — Generates and caches a root CA certificate,
 * then issues per-host leaf certificates on demand for MITM TLS interception.
 */
export class CaManager {
  private caKey: forge.pki.rsa.KeyPair | null = null;
  private caCert: forge.pki.Certificate | null = null;
  /** LRU-ish cache: hostname → tls.SecureContext */
  private contextCache = new Map<string, tls.SecureContext>();

  constructor(private certsDir: string) {}

  /**
   * Load existing CA from disk, or generate a new one.
   */
  async init(): Promise<void> {
    if (!existsSync(this.certsDir)) {
      mkdirSync(this.certsDir, { recursive: true });
    }

    const keyPath = join(this.certsDir, CA_KEY_FILE);
    const certPath = join(this.certsDir, CA_CERT_FILE);

    if (existsSync(keyPath) && existsSync(certPath)) {
      const keyPem = readFileSync(keyPath, "utf-8");
      const certPem = readFileSync(certPath, "utf-8");
      const privateKey = forge.pki.privateKeyFromPem(keyPem);
      this.caKey = {
        privateKey,
        publicKey: forge.pki.setRsaPublicKey(privateKey.n, privateKey.e),
      } as forge.pki.rsa.KeyPair;
      this.caCert = forge.pki.certificateFromPem(certPem);
    } else {
      await this.generate();
    }
  }

  isInitialized(): boolean {
    return this.caCert !== null && this.caKey !== null;
  }

  getCaCertPath(): string {
    return join(this.certsDir, CA_CERT_FILE);
  }

  /**
   * Get the CA certificate in DER (binary) format for mobile download.
   */
  getCaCertDer(): Buffer {
    if (!this.caCert) throw new Error("CA not initialized");
    const asn1 = forge.pki.certificateToAsn1(this.caCert);
    const der = forge.asn1.toDer(asn1);
    return Buffer.from(der.getBytes(), "binary");
  }

  /**
   * Get (or create) a TLS SecureContext for the given hostname.
   */
  getSecureContextForHost(hostname: string): tls.SecureContext {
    const cached = this.contextCache.get(hostname);
    if (cached) return cached;

    // Evict oldest if cache full
    if (this.contextCache.size >= CACHE_MAX_SIZE) {
      const oldest = this.contextCache.keys().next().value!;
      this.contextCache.delete(oldest);
    }

    const { key, cert } = this.issueLeafCert(hostname);
    const ctx = tls.createSecureContext({
      key,
      cert,
      ca: forge.pki.certificateToPem(this.caCert!),
    });
    this.contextCache.set(hostname, ctx);
    return ctx;
  }

  /**
   * Delete existing CA, generate a new one, clear cache.
   */
  async regenerate(): Promise<void> {
    this.contextCache.clear();
    await this.generate();
  }

  // ---- Private ----

  private async generate(): Promise<void> {
    const keys = forge.pki.rsa.generateKeyPair({ bits: 2048 });
    this.caKey = keys;

    const cert = forge.pki.createCertificate();
    cert.publicKey = keys.publicKey;
    cert.serialNumber = this.randomSerial();

    const now = new Date();
    cert.validity.notBefore = now;
    cert.validity.notAfter = new Date(
      now.getFullYear() + CA_VALIDITY_YEARS,
      now.getMonth(),
      now.getDate(),
    );

    const attrs: forge.pki.CertificateField[] = [
      { shortName: "CN", value: "Anything Analyzer CA" },
      { shortName: "O", value: "Anything Analyzer" },
    ];
    cert.setSubject(attrs);
    cert.setIssuer(attrs);

    cert.setExtensions([
      { name: "basicConstraints", cA: true, critical: true },
      {
        name: "keyUsage",
        keyCertSign: true,
        cRLSign: true,
        critical: true,
      },
      {
        name: "subjectKeyIdentifier",
      },
    ]);

    cert.sign(keys.privateKey, forge.md.sha256.create());
    this.caCert = cert;

    // Persist
    const keyPem = forge.pki.privateKeyToPem(keys.privateKey);
    const certPem = forge.pki.certificateToPem(cert);
    writeFileSync(join(this.certsDir, CA_KEY_FILE), keyPem, "utf-8");
    writeFileSync(join(this.certsDir, CA_CERT_FILE), certPem, "utf-8");
  }

  private issueLeafCert(hostname: string): { key: string; cert: string } {
    if (!this.caKey || !this.caCert) {
      throw new Error("CA not initialized");
    }

    const keys = forge.pki.rsa.generateKeyPair({ bits: 2048 });
    const cert = forge.pki.createCertificate();

    cert.publicKey = keys.publicKey;
    cert.serialNumber = this.randomSerial();

    const now = new Date();
    cert.validity.notBefore = now;
    cert.validity.notAfter = new Date(
      now.getFullYear(),
      now.getMonth(),
      now.getDate() + LEAF_VALIDITY_DAYS,
    );

    cert.setSubject([{ shortName: "CN", value: hostname }]);
    cert.setIssuer(this.caCert.subject.attributes);

    // SAN: support both DNS name and IP address
    const isIP = /^[\d.]+$/.test(hostname) || hostname.includes(":");
    const altNames: { type: number; value?: string; ip?: string }[] = isIP
      ? [{ type: 7, ip: hostname }]
      : [{ type: 2, value: hostname }];

    cert.setExtensions([
      { name: "basicConstraints", cA: false },
      {
        name: "keyUsage",
        digitalSignature: true,
        keyEncipherment: true,
      },
      { name: "extKeyUsage", serverAuth: true },
      { name: "subjectAltName", altNames },
      { name: "subjectKeyIdentifier" },
      {
        name: "authorityKeyIdentifier",
        // AKI 必须等于 CA 的 SKI；node-forge 的 keyIdentifier:true 会错用叶子自己的公钥，
        // 导致每个域名 AKI 都是"随机值"，Android CertPathValidator 会判定 trust anchor 不匹配。
        keyIdentifier: this.caCert!.generateSubjectKeyIdentifier().getBytes(),
      },
    ]);

    cert.sign(this.caKey.privateKey, forge.md.sha256.create());

    // Include CA cert in chain so mobile clients can verify
    const leafPem = forge.pki.certificateToPem(cert);
    const caPem = forge.pki.certificateToPem(this.caCert!);
    return {
      key: forge.pki.privateKeyToPem(keys.privateKey),
      cert: leafPem + caPem,
    };
  }

  private randomSerial(): string {
    return forge.util.bytesToHex(forge.random.getBytesSync(16));
  }
}
