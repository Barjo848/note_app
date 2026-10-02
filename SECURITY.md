# Security

## What Note does with your files

- The page runs in your browser. With the direct request unused, it makes no network connection.
- Opening a WAV reads that file. Saving writes a JSON notes file where you choose, or downloads it. The WAV is left as it is.
- The API key, when you save one, stays in that browser under `localStorage` key `note:anthropicApiKey`. The model string is `note:anthropicModel`.
- The direct-send button asks before it runs. Confirming sends the text bundle to `https://api.anthropic.com/v1/messages`. The bundle contains metadata, notes, and a descriptor table. It contains no audio samples. The key goes out only as the request header for that call.
- WAV headers are read by `WavReader` in `js/wav.js`. Notes and loop documents are read by the app's own JSON checks against `notes.schema.json` and `loops.schema.json`. A document that fails the schema is refused.

## Reporting a problem

Please report privately first, using GitHub's "Report a vulnerability" button on this repository's Security tab.

Useful reports include:

- a file that crashes the tab, or makes it hang;
- a notes file that loses positions, or moves them onto a different bounce without the confirm dialog;
- audio that left the machine without the confirm dialog.

If the file is private, describe how it was produced instead of attaching it. Ordinary bugs that expose nothing sensitive can go in a public issue.
