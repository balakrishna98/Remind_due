# PaymentsReminder (Expo + EAS) — Build iOS from Windows

You can ship to the **Apple App Store from Windows** using **Expo Application Services (EAS Build)**. No Mac required.

## Prereqs
- Install Node 18+ and Git
- `npm i -g eas-cli expo-cli`
- Apple Developer Program account (paid)
- Expo account (`eas login`)

## Setup
```bash
npm install
npm run start
```
Open the QR in Expo Go to preview.

## iOS Build (cloud)
```bash
eas login
eas build -p ios --profile production
```
- When asked, let EAS **create iOS credentials automatically**.
- After the build finishes, download the `.ipa` or send to TestFlight.

## Submit to App Store
```bash
eas submit -p ios --latest
```
- Provide an **App Store Connect API key** when prompted (EAS can store it).

## Notes
- Local notifications are scheduled with `expo-notifications`. iOS will ask permission the first time.
- Data is in-memory for simplicity. Add `expo-sqlite` or `mmkv` for persistence.
- Change `app.json` → `expo.ios.bundleIdentifier` if `com.balu.paymentsreminder` is taken.
- Android build: `eas build -p android --profile production`.