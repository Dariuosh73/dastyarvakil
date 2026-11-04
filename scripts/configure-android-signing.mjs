
import { readFile, writeFile } from "node:fs/promises";

const file = "android/app/build.gradle";
let gradle = await readFile(file, "utf8");

const required = [
  "STORE_PASSWORD",
  "KEY_ALIAS",
  "KEY_PASSWORD"
];

for (const name of required) {
  if (!process.env[name]) {
    throw new Error(`Missing environment variable: ${name}`);
  }
}

if (!gradle.includes("signingConfigs")) {
  const androidBlock = gradle.indexOf("android {");
  const buildTypes = gradle.indexOf("buildTypes {", androidBlock);

  if (androidBlock < 0 || buildTypes < 0) {
    throw new Error("Could not locate Android buildTypes block");
  }

  const signingConfig = `
    signingConfigs {
        release {
            storeFile file(System.getenv("RUNNER_TEMP") + "/release-keystore.p12")
            storePassword System.getenv("STORE_PASSWORD")
            keyAlias System.getenv("KEY_ALIAS")
            keyPassword System.getenv("KEY_PASSWORD")
        }
    }

`;

  gradle =
    gradle.slice(0, buildTypes) +
    signingConfig +
    gradle.slice(buildTypes);
}

const releaseBlock = gradle.indexOf("release {", gradle.indexOf("buildTypes {"));

if (releaseBlock < 0) {
  throw new Error("Could not locate release build type");
}

const nextBrace = gradle.indexOf("}", releaseBlock);

if (nextBrace < 0) {
  throw new Error("Could not locate end of release block");
}

const releaseContent = gradle.slice(releaseBlock, nextBrace);

if (!releaseContent.includes("signingConfig")) {
  gradle =
    gradle.slice(0, releaseBlock + "release {".length) +
    "\n            signingConfig signingConfigs.release" +
    gradle.slice(releaseBlock + "release {".length);
}

await writeFile(file, gradle, "utf8");
console.log("Release signing configuration added.");
