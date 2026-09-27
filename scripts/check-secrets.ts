import process from 'node:process';

import { scanWorkspace } from './secret-scan.ts';

try {
  const findings = scanWorkspace(process.cwd());
  if (findings.length === 0) {
    process.stdout.write('✅ Secret scan passed (working tree only; Git history is not scanned).\n');
  } else {
    for (const finding of findings) {
      // Deliberately report location and kind only; never print the matched bytes.
      process.stderr.write(`Possible secret: ${finding.file}:${finding.line} (${finding.kind})\n`);
    }
    process.exitCode = 1;
  }
} catch {
  process.stderr.write('Secret scan could not read the working tree; refusing to report success.\n');
  process.exitCode = 2;
}
