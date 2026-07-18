/**
 * Verification script for the AKI patch in src/main/proxy/ca-manager.ts.
 * Replicates the EXACT post-patch logic from that file:
 *   - generate() with subjectKeyIdentifier
 *   - issueLeafCert() with authorityKeyIdentifier.keyIdentifier = CA's SKI bytes
 *
 * Outputs:
 *   - ca-cert.pem, ca-key.pem
 *   - leaf-{hostname}.pem (one per host, includes chained CA PEM at end)
 *
 * Then openssl does the actual verification.
 */
const forge = require("node-forge");
const fs = require("fs");
const path = require("path");

const OUT = path.join(__dirname, "verify-out");
fs.mkdirSync(OUT, { recursive: true });

const CA_VALIDITY_YEARS = 10;
const LEAF_VALIDITY_DAYS = 825;

function randomSerial() {
  return forge.util.bytesToHex(forge.random.getBytesSync(16));
}

function generateCA() {
  const keys = forge.pki.rsa.generateKeyPair({ bits: 2048 });
  const cert = forge.pki.createCertificate();
  cert.publicKey = keys.publicKey;
  cert.serialNumber = randomSerial();

  const now = new Date();
  cert.validity.notBefore = now;
  cert.validity.notAfter = new Date(
    now.getFullYear() + CA_VALIDITY_YEARS,
    now.getMonth(),
    now.getDate(),
  );

  const attrs = [
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
    { name: "subjectKeyIdentifier" },
  ]);

  cert.sign(keys.privateKey, forge.md.sha256.create());

  return { cert, key: keys.privateKey };
}

function issueLeafCert(caCert, caKey, hostname) {
  const keys = forge.pki.rsa.generateKeyPair({ bits: 2048 });
  const cert = forge.pki.createCertificate();

  cert.publicKey = keys.publicKey;
  cert.serialNumber = randomSerial();

  const now = new Date();
  cert.validity.notBefore = now;
  cert.validity.notAfter = new Date(
    now.getFullYear(),
    now.getMonth(),
    now.getDate() + LEAF_VALIDITY_DAYS,
  );

  cert.setSubject([{ shortName: "CN", value: hostname }]);
  cert.setIssuer(caCert.subject.attributes);

  const isIP = /^[\d.]+$/.test(hostname) || hostname.includes(":");
  const altNames = isIP
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
      // PATCHED VERSION — same as ca-manager.ts:188
      keyIdentifier: caCert.generateSubjectKeyIdentifier().getBytes(),
    },
  ]);

  cert.sign(caKey, forge.md.sha256.create());

  return { cert, key: keys.privateKey };
}

function bytesToColonHex(binary) {
  const hex = forge.util.bytesToHex(binary);
  return hex.toUpperCase().match(/.{1,2}/g).join(":");
}

// --- Run ---
const { cert: caCert, key: caKey } = generateCA();
const caPem = forge.pki.certificateToPem(caCert);
const caKeyPem = forge.pki.privateKeyToPem(caKey);

fs.writeFileSync(path.join(OUT, "ca-cert.pem"), caPem);
fs.writeFileSync(path.join(OUT, "ca-key.pem"), caKeyPem);

const caSkiBinary = caCert.generateSubjectKeyIdentifier().getBytes();
const caSki = bytesToColonHex(caSkiBinary);
console.log(`CA SKI : ${caSki}`);

for (const host of ["mumu.163.com", "www.aliyun.com"]) {
  const { cert: leafCert, key: leafKey } = issueLeafCert(caCert, caKey, host);
  const leafPem = forge.pki.certificateToPem(leafCert);
  // Same chain shape as the real code: leaf + ca appended
  fs.writeFileSync(path.join(OUT, `leaf-${host}.pem`), leafPem + caPem);
  fs.writeFileSync(path.join(OUT, `leaf-${host}-only.pem`), leafPem);
  console.log(`\n[${host}]`);
  console.log(`  Leaf SKI : ${bytesToColonHex(leafCert.generateSubjectKeyIdentifier().getBytes())}`);
  console.log(`  (AKI verification delegated to openssl — see below)`);
}

console.log(`\nFiles written to: ${OUT}`);