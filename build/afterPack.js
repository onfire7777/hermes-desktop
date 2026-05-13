const { execSync } = require("child_process");
const path = require("path");

exports.default = async function afterPack(context) {
  if (context.electronPlatformName !== "darwin") return;

  const appPath = path.join(
    context.appOutDir,
    `${context.packager.appInfo.productFilename}.app`,
  );

  console.log(`Ad-hoc re-signing (inside-out): ${appPath}`);

  // Sign leaf binaries before the outer app so macOS verification does not
  // reject nested Electron frameworks.
  execSync(
    `find "${appPath}" -name "*.dylib" | while IFS= read -r f; do codesign --force --sign - "$f" 2>/dev/null || true; done`,
    { stdio: "inherit", shell: "/bin/bash" },
  );

  execSync(
    `find "${appPath}/Contents/Frameworks" -mindepth 1 -maxdepth 4 \\( -name "*.xpc" -o -name "*.app" \\) -prune | while IFS= read -r f; do codesign --force --sign - "$f" 2>/dev/null || true; done`,
    { stdio: "inherit", shell: "/bin/bash" },
  );

  execSync(
    `find "${appPath}/Contents/Frameworks" -mindepth 1 -maxdepth 1 -name "*.framework" | while IFS= read -r f; do codesign --force --sign - "$f" 2>/dev/null || true; done`,
    { stdio: "inherit", shell: "/bin/bash" },
  );

  execSync(`codesign --force --sign - "${appPath}"`, { stdio: "inherit" });

  console.log("Ad-hoc re-signing complete.");
};
