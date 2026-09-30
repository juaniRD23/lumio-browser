// Windows Hello (face, fingerprint or PIN) through Windows PowerShell 5.1's
// WinRT support. Resolves 'verified', 'failed', or 'unavailable' (not
// Windows, Hello not set up, or PowerShell missing). The reason text goes in
// an environment variable, never into the script itself.
const { execFile } = require('child_process');

const SCRIPT = `
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Runtime.WindowsRuntime
$asTask = ([System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object { $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation\`1' })[0]
function Wait-WinRt($op, $type) { $t = $asTask.MakeGenericMethod($type).Invoke($null, @($op)); $t.Wait(-1) | Out-Null; $t.Result }
[Windows.Security.Credentials.UI.UserConsentVerifier, Windows.Security.Credentials.UI, ContentType = WindowsRuntime] | Out-Null
$available = Wait-WinRt ([Windows.Security.Credentials.UI.UserConsentVerifier]::CheckAvailabilityAsync()) ([Windows.Security.Credentials.UI.UserConsentVerifierAvailability])
if ($available -ne 'Available') { 'unavailable'; exit }
$result = Wait-WinRt ([Windows.Security.Credentials.UI.UserConsentVerifier]::RequestVerificationAsync($env:LUMIO_HELLO_REASON)) ([Windows.Security.Credentials.UI.UserConsentVerificationResult])
if ($result -eq 'Verified') { 'verified' } else { 'failed' }
`;

function windowsHello(reason = 'Lumio Browser wants to confirm it’s you') {
  if (process.platform !== 'win32') return Promise.resolve('unavailable');
  return new Promise((resolve) => {
    execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', SCRIPT], {
      env: { ...process.env, LUMIO_HELLO_REASON: `Lumio Browser: ${String(reason).slice(0, 100)}` },
      windowsHide: true,
      timeout: 120000,
    }, (err, stdout) => {
      const out = String(stdout || '').trim().split(/\r?\n/).pop();
      resolve(err ? 'unavailable' : ['verified', 'failed', 'unavailable'].includes(out) ? out : 'unavailable');
    });
  });
}

module.exports = { windowsHello };
