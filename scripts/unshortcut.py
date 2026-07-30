#!/usr/bin/env python3
"""Decrypt a signed .shortcut (AEA1) and print its workflow plist."""
import plistlib, struct, subprocess, sys, tempfile, os, json

def load_shortcut(path):
    d = open(path, "rb").read()
    if d[:4] != b"AEA1":
        return plistlib.loads(d)  # already unsigned
    n = struct.unpack("<I", d[8:12])[0]
    hdr = plistlib.loads(d[12:12+n])
    leaf = hdr["SigningCertificateChain"][0]
    with tempfile.TemporaryDirectory() as td:
        der = os.path.join(td, "leaf.der"); open(der, "wb").write(leaf)
        pem = os.path.join(td, "pub.pem")
        with open(pem, "wb") as f:
            f.write(subprocess.run(["openssl","x509","-inform","DER","-in",der,
                                    "-pubkey","-noout"], capture_output=True).stdout)
        raw = os.path.join(td, "raw.bin")
        subprocess.run(["aea","decrypt","-i",path,"-o",raw,"-sign-pub",pem],
                       capture_output=True)
        b = open(raw, "rb").read()
    i = b.find(b"bplist00")
    if i < 0: raise SystemExit("no bplist found in archive payload")
    return plistlib.loads(b[i:])

if __name__ == "__main__":
    wf = load_shortcut(sys.argv[1])
    for k, v in wf.items():
        if k != "WFWorkflowActions":
            print(f"{k}: {v}")
    print("\n=== ACTIONS ===")
    for n, a in enumerate(wf.get("WFWorkflowActions", [])):
        print(f"\n[{n}] {a.get('WFWorkflowActionIdentifier')}")
        print(json.dumps(a.get("WFWorkflowActionParameters", {}),
                         indent=2, default=str))
