// Runs after `npx cap add android` / `cap sync`: adds the in-app APK installer,
// the install permission, and sets versionName / versionCode from APP_VERSION.
import { readFile, writeFile, access, readdir, copyFile, mkdir } from "node:fs/promises";
import { join } from "node:path";

const cfg = JSON.parse(await readFile("capacitor.config.json", "utf8"));
const pkg = cfg.appId;
const dir = `android/app/src/main/java/${pkg.replaceAll(".", "/")}`;
await access(dir);

const plugin = `package ${pkg};

import android.content.Intent;
import android.net.Uri;
import android.os.Build;
import android.provider.Settings;
import androidx.core.content.FileProvider;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import java.io.File;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.util.Locale;

@CapacitorPlugin(name = "ApkInstaller")
public class ApkInstallerPlugin extends Plugin {
    private static final String PREFIX = "https://github.com/dariuosh73/dastyarvakil/releases/download/";

    @PluginMethod
    public void install(final PluginCall call) {
        final String url = call.getString("url");
        if (url == null || !url.toLowerCase(Locale.ROOT).startsWith(PREFIX)) {
            call.reject("bad_url", "bad_url");
            return;
        }
        if (Build.VERSION.SDK_INT >= 26 && !getContext().getPackageManager().canRequestPackageInstalls()) {
            Intent s = new Intent(Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES,
                    Uri.parse("package:" + getContext().getPackageName()));
            s.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
            getContext().startActivity(s);
            call.reject("permission", "permission");
            return;
        }
        new Thread(() -> {
            try {
                File d = new File(getContext().getCacheDir(), "updates");
                d.mkdirs();
                File out = new File(d, "update.apk");
                HttpURLConnection c = (HttpURLConnection) new URL(url).openConnection();
                c.setConnectTimeout(20000);
                c.setReadTimeout(30000);
                c.setInstanceFollowRedirects(true);
                if (c.getResponseCode() != 200) throw new Exception("http_" + c.getResponseCode());
                try (InputStream in = c.getInputStream(); FileOutputStream os = new FileOutputStream(out)) {
                    byte[] b = new byte[65536];
                    int n;
                    while ((n = in.read(b)) > 0) os.write(b, 0, n);
                }
                c.disconnect();
                if (out.length() < 100000) throw new Exception("too_small");
                Uri uri = FileProvider.getUriForFile(getContext(), getContext().getPackageName() + ".fileprovider", out);
                Intent i = new Intent(Intent.ACTION_VIEW);
                i.setDataAndType(uri, "application/vnd.android.package-archive");
                i.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION | Intent.FLAG_ACTIVITY_NEW_TASK);
                getContext().startActivity(i);
                call.resolve(new JSObject());
            } catch (Exception e) {
                call.reject("download_failed: " + e.getMessage(), "download_failed");
            }
        }).start();
    }
}
`;
await writeFile(`${dir}/ApkInstallerPlugin.java`, plugin, "utf8");

await writeFile(`${dir}/MainActivity.java`, `package ${pkg};

import android.os.Bundle;
import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(Bundle savedInstanceState) {
        registerPlugin(ApkInstallerPlugin.class);
        super.onCreate(savedInstanceState);
    }
}
`, "utf8");

const mf = "android/app/src/main/AndroidManifest.xml";
let m = await readFile(mf, "utf8");
if (!m.includes("REQUEST_INSTALL_PACKAGES")) {
  m = m.replace("</manifest>", '    <uses-permission android:name="android.permission.REQUEST_INSTALL_PACKAGES" />\n</manifest>');
  await writeFile(mf, m, "utf8");
}

const fp = "android/app/src/main/res/xml/file_paths.xml";
let f = await readFile(fp, "utf8");
if (!f.includes("<cache-path")) {
  f = f.replace("</paths>", '    <cache-path name="my_cache_images" path="." />\n</paths>');
  await writeFile(fp, f, "utf8");
}

// App icon + splash: copy the prepared images into the generated Android project.
const res = "android/app/src/main/res";
const iconsDir = "android-icons";
for (const d of await readdir(iconsDir, { withFileTypes: true })) {
  if (d.isDirectory() && d.name.startsWith("mipmap-")) {
    await mkdir(join(res, d.name), { recursive: true });
    for (const f of await readdir(join(iconsDir, d.name))) {
      await copyFile(join(iconsDir, d.name, f), join(res, d.name, f));
    }
  }
}
await mkdir(join(res, "values"), { recursive: true });
await copyFile(join(iconsDir, "ic_launcher_background.xml"), join(res, "values", "ic_launcher_background.xml"));
// splash: overwrite every existing splash.png with the navy splash image
for (const d of await readdir(res, { withFileTypes: true })) {
  if (d.isDirectory() && d.name.startsWith("drawable")) {
    const target = join(res, d.name, "splash.png");
    try { await access(target); await copyFile(join(iconsDir, "drawable", "splash.png"), target); } catch {}
  }
}
console.log("Icons and splash installed.");

const v = process.env.APP_VERSION;
if (v) {
  const p = v.split(".").map(Number);
  if (p.length !== 3 || p.some(Number.isNaN)) throw new Error("APP_VERSION must be like 1.0.1");
  const code = p[0] * 10000 + p[1] * 100 + p[2];
  const gf = "android/app/build.gradle";
  let g = await readFile(gf, "utf8");
  if (!/versionCode\s+\d+/.test(g) || !/versionName\s+"[^"]*"/.test(g)) throw new Error("version fields not found");
  g = g.replace(/versionCode\s+\d+/, `versionCode ${code}`).replace(/versionName\s+"[^"]*"/, `versionName "${v}"`);
  await writeFile(gf, g, "utf8");
  console.log(`versionName ${v}, versionCode ${code}`);
}
console.log("Android project patched.");
