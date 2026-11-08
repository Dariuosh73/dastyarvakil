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

// Native biometric gate: uses AndroidX BiometricPrompt + an AndroidKeyStore AES key that
// requires a fresh biometric (or device-credential) check for every encrypt/decrypt. The
// secret itself (the account's login password) never leaves the device and is only ever
// held in memory for the moment it is wrapped/unwrapped; it is not readable without passing
// the biometric prompt each time, because the key is created with setUserAuthenticationRequired(true).
const biometricPlugin = `package ${pkg};

import android.content.Context;
import android.content.SharedPreferences;
import android.security.keystore.KeyGenParameterSpec;
import android.security.keystore.KeyProperties;
import android.util.Base64;
import androidx.biometric.BiometricManager;
import androidx.biometric.BiometricPrompt;
import androidx.core.content.ContextCompat;
import androidx.fragment.app.FragmentActivity;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import java.nio.charset.StandardCharsets;
import java.security.KeyStore;
import java.util.concurrent.Executor;
import javax.crypto.Cipher;
import javax.crypto.KeyGenerator;
import javax.crypto.SecretKey;
import javax.crypto.spec.GCMParameterSpec;

@CapacitorPlugin(name = "NativeBiometric")
public class NativeBiometricPlugin extends Plugin {
    private static final String PREFS = "vz_bio";
    private static final String KS = "AndroidKeyStore";

    @PluginMethod
    public void isAvailable(PluginCall call) {
        BiometricManager bm = BiometricManager.from(getContext());
        int res = bm.canAuthenticate(BiometricManager.Authenticators.BIOMETRIC_STRONG);
        JSObject ret = new JSObject();
        ret.put("isAvailable", res == BiometricManager.BIOMETRIC_SUCCESS);
        call.resolve(ret);
    }

    @PluginMethod
    public void setSecret(final PluginCall call) {
        final String account = call.getString("account");
        final String secret = call.getString("secret");
        if (account == null || secret == null) { call.reject("missing_params"); return; }
        try {
            SecretKey key = makeKey(account);
            Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding");
            cipher.init(Cipher.ENCRYPT_MODE, key);
            authenticate(call, new BiometricPrompt.CryptoObject(cipher), result -> {
                try {
                    Cipher c = result.getCryptoObject().getCipher();
                    byte[] iv = c.getIV();
                    byte[] ct = c.doFinal(secret.getBytes(StandardCharsets.UTF_8));
                    SharedPreferences prefs = getContext().getSharedPreferences(PREFS, Context.MODE_PRIVATE);
                    prefs.edit().putString("blob_" + account,
                            Base64.encodeToString(iv, Base64.NO_WRAP) + "." + Base64.encodeToString(ct, Base64.NO_WRAP)).apply();
                    call.resolve(new JSObject());
                } catch (Exception e) {
                    call.reject("encrypt_failed: " + e.getMessage());
                }
            });
        } catch (Exception e) {
            call.reject("keystore_error: " + e.getMessage());
        }
    }

    @PluginMethod
    public void getSecret(final PluginCall call) {
        final String account = call.getString("account");
        if (account == null) { call.reject("missing_params"); return; }
        SharedPreferences prefs = getContext().getSharedPreferences(PREFS, Context.MODE_PRIVATE);
        String blob = prefs.getString("blob_" + account, null);
        if (blob == null || !blob.contains(".")) { call.reject("no_secret"); return; }
        try {
            String[] parts = blob.split("\\\\.", 2);
            byte[] iv = Base64.decode(parts[0], Base64.NO_WRAP);
            final byte[] ct = Base64.decode(parts[1], Base64.NO_WRAP);
            KeyStore ks = KeyStore.getInstance(KS);
            ks.load(null);
            SecretKey key = (SecretKey) ks.getKey("vz_bio_" + account, null);
            if (key == null) { call.reject("no_key"); return; }
            Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding");
            cipher.init(Cipher.DECRYPT_MODE, key, new GCMParameterSpec(128, iv));
            authenticate(call, new BiometricPrompt.CryptoObject(cipher), result -> {
                try {
                    Cipher c = result.getCryptoObject().getCipher();
                    byte[] pt = c.doFinal(ct);
                    JSObject ret = new JSObject();
                    ret.put("secret", new String(pt, StandardCharsets.UTF_8));
                    call.resolve(ret);
                } catch (Exception e) {
                    call.reject("decrypt_failed: " + e.getMessage());
                }
            });
        } catch (Exception e) {
            call.reject("read_failed: " + e.getMessage());
        }
    }

    @PluginMethod
    public void removeSecret(PluginCall call) {
        final String account = call.getString("account");
        try {
            if (account != null) {
                KeyStore ks = KeyStore.getInstance(KS);
                ks.load(null);
                if (ks.containsAlias("vz_bio_" + account)) ks.deleteEntry("vz_bio_" + account);
                getContext().getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit().remove("blob_" + account).apply();
            }
        } catch (Exception ignored) {}
        call.resolve();
    }

    private SecretKey makeKey(String account) throws Exception {
        KeyStore ks = KeyStore.getInstance(KS);
        ks.load(null);
        String alias = "vz_bio_" + account;
        if (ks.containsAlias(alias)) ks.deleteEntry(alias);
        KeyGenParameterSpec spec = new KeyGenParameterSpec.Builder(alias,
                KeyProperties.PURPOSE_ENCRYPT | KeyProperties.PURPOSE_DECRYPT)
                .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
                .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
                .setUserAuthenticationRequired(true)
                .setInvalidatedByBiometricEnrollment(true)
                .build();
        KeyGenerator kg = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, KS);
        kg.init(spec);
        return kg.generateKey();
    }

    private interface OnOk { void run(BiometricPrompt.AuthenticationResult result); }

    private void authenticate(final PluginCall call, final BiometricPrompt.CryptoObject cryptoObject, final OnOk onOk) {
        final FragmentActivity activity = (FragmentActivity) getActivity();
        activity.runOnUiThread(() -> {
            Executor executor = ContextCompat.getMainExecutor(getContext());
            BiometricPrompt prompt = new BiometricPrompt(activity, executor, new BiometricPrompt.AuthenticationCallback() {
                @Override
                public void onAuthenticationSucceeded(BiometricPrompt.AuthenticationResult result) {
                    onOk.run(result);
                }
                @Override
                public void onAuthenticationError(int errorCode, CharSequence errString) {
                    call.reject("auth_error: " + errString, String.valueOf(errorCode));
                }
                @Override
                public void onAuthenticationFailed() {
                    // let the system prompt retry; only error/cancel ends the call
                }
            });
            BiometricPrompt.PromptInfo promptInfo = new BiometricPrompt.PromptInfo.Builder()
                    .setTitle("ورود به دستیار وکیل")
                    .setSubtitle("با اثر انگشت تأیید کنید")
                    .setNegativeButtonText("انصراف")
                    .setAllowedAuthenticators(BiometricManager.Authenticators.BIOMETRIC_STRONG)
                    .build();
            prompt.authenticate(promptInfo, cryptoObject);
        });
    }
}
`;
await writeFile(`${dir}/NativeBiometricPlugin.java`, biometricPlugin, "utf8");

await writeFile(`${dir}/MainActivity.java`, `package ${pkg};

import android.os.Bundle;
import android.view.WindowManager;
import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(Bundle savedInstanceState) {
        registerPlugin(ApkInstallerPlugin.class);
        registerPlugin(NativeBiometricPlugin.class);
        super.onCreate(savedInstanceState);
        // Hide content in the recents screen and block screenshots / screen recording.
        getWindow().setFlags(WindowManager.LayoutParams.FLAG_SECURE, WindowManager.LayoutParams.FLAG_SECURE);
    }
}
`, "utf8");

// androidx.biometric for the native biometric plugin above.
{
  const gf = "android/app/build.gradle";
  let g = await readFile(gf, "utf8");
  if (!g.includes("androidx.biometric:biometric")) {
    g = g.replace(/dependencies\s*\{/, (m) => `${m}\n    implementation "androidx.biometric:biometric:1.1.0"`);
    await writeFile(gf, g, "utf8");
  }
}

const mf = "android/app/src/main/AndroidManifest.xml";
let m = await readFile(mf, "utf8");
if (!m.includes("REQUEST_INSTALL_PACKAGES")) {
  m = m.replace("</manifest>", '    <uses-permission android:name="android.permission.REQUEST_INSTALL_PACKAGES" />\n</manifest>');
  await writeFile(mf, m, "utf8");
}
m = await readFile(mf, "utf8");
if (!m.includes("POST_NOTIFICATIONS")) {
  m = m.replace("</manifest>", '    <uses-permission android:name="android.permission.POST_NOTIFICATIONS" />\n</manifest>');
  await writeFile(mf, m, "utf8");
}
if (!m.includes("USE_BIOMETRIC")) {
  m = m.replace("</manifest>", '    <uses-permission android:name="android.permission.USE_BIOMETRIC" />\n</manifest>');
  await writeFile(mf, m, "utf8");
}

// Hardening: no automatic system backup of app data, no cleartext traffic.
m = await readFile(mf, "utf8");
m = m.replace(/android:allowBackup="true"/, 'android:allowBackup="false"');
if (!m.includes("usesCleartextTraffic")) {
  m = m.replace("<application", '<application android:usesCleartextTraffic="false"');
}
await writeFile(mf, m, "utf8");

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
