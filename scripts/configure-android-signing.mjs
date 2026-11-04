
import { readFile, writeFile } from "node:fs/promises";

const file = "android/app/build.gradle";
let gradle = await readFile(file, "utf8");

for (const name of [
  "STORE_PASSWORD",
  "KEY_ALIAS",
  "KEY_PASSWORD",
  "RUNNER_TEMP"
]) {
  if (!process.env[name]) {
    throw new Error(`Missing environment variable: ${name}`);
  }
}

const androidStart = gradle.indexOf("android {");
const buildTypesStart = gradle.indexOf("buildTypes {", androidStart);

if (androidStart < 0 || buildTypesStart < 0) {
  throw new Error("Android or buildTypes block not found");
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
  gradle.slice(0, buildTypesStart) +
  signingConfig +
  gradle.slice(buildTypesStart);

const releaseStart = gradle.indexOf("release {", buildTypesStart);

if (releaseStart < 0) {
  throw new Error("Release build type not found");
}

const insertAt = releaseStart + "release {".length;

gradle =
  gradle.slice(0, insertAt) +
  "\n            signingConfig signingConfigs.release" +
  gradle.slice(insertAt);

await writeFile(file, gradle, "utf8");
console.log("Release signing configuration added.");
