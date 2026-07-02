# Unnoticed Dance

Unnoticed Dance is a browser-based prototype for recording body motion from a webcam and replaying it through multiple motion-transformation rules.

## Requirements

- Chrome or another modern browser with webcam support
- HTTPS when shared online
- Camera permission enabled in the browser

The app keeps motion data in the browser. Original video export is optional and is downloaded as a local `.webm` file when recording stops.

## Run locally

```bash
npm install
npm run dev
```

Open the local URL printed by Vite.

## Build

```bash
npm run build
```

The production files are generated in `dist`.

## Deploy to Netlify

This project includes `netlify.toml`, so Netlify can use the correct build settings automatically.

Recommended settings:

- Build command: `npm run build`
- Publish directory: `dist`

### Option A: Git deploy

1. Push this project to GitHub.
2. Open Netlify and choose `Add new site` -> `Import an existing project`.
3. Select the GitHub repository.
4. Confirm the build settings above.
5. Deploy.

After deployment, Netlify will provide an HTTPS URL. Share that URL with participants.

### Option B: Manual deploy

1. Run `npm run build`.
2. Open Netlify and choose a manual deploy.
3. Upload the `dist` folder.

Manual deploy is quick for testing, but Git deploy is better if the app will keep changing.

## Notes for users

- Click `Retry Camera` if the camera permission dialog was dismissed.
- Click `Start Recording` and move in front of the webcam.
- Click `Stop Recording` to save the motion.
- Use `Play Original` or `Play Dance` to replay it.
- Enable `Save original video` before recording if you also want the raw webcam video saved locally.
