# Stride — Command Cheatsheet

## OTA Update (JS/TS changes only — no App Store review)
```
git push origin master
eas update --channel preview --platform ios
```
Users get it silently on next app launch.

⚠️ Do NOT bump `version` in `app.json` for OTA-only pushes. With the fingerprint runtimeVersion policy, changing `version` shifts the fingerprint hash — the update will be published but silently skipped by every installed device because the runtime versions won't match. Only bump `version` when doing a new `eas build`.

## New Build (native layer changed, or first time on a device)
```
eas build --profile preview --platform ios
```
Required when: adding a native package, changing config plugins, or first install on a device.

## How to know if you need a build vs. an OTA update
```
npx expo fingerprint .
```
Compare output to previous — if the hash changed, you need a new build. If same, OTA is fine.

## Add a new test device (do this before building)
```
eas device:create
```
Generates a link — they open it on their iPhone and install a profile. Run before `eas build` so their device is included.

## Production (App Store)
```
eas build --profile production --platform ios
eas submit --platform ios
```

## View recent builds
```
eas build:list
```

## View recent OTA updates
```
eas update:list
```

---

## Rules of thumb
- JS/TS only changed → OTA update
- New native package / config plugin changed → new build
- New device needs access → `eas device:create` first, then build
- Always `--platform ios` on `eas update` — omitting it bundles web and fails
