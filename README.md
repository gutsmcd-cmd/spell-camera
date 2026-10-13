# スペルチェックカメラ / Spell Check Camera

看板やメニューの英語のミスを見つける。Spot English spelling mistakes on signs and menus.

- Take a photo, pick one, or snap from the live camera.
- On-device OCR (Tesseract.js, English LSTM model ~3 MB, downloaded once from jsDelivr and cached).
- Offline spell check with Hunspell dictionaries (en_US / en_GB toggle, via nspell), fetched once and cached.
- Red squiggles under misspelled words on the photo; tap a word for suggestions. Grey dotted = the OCR wasn't sure.
- Light grammar hints (orange, clearly marked as hints): repeated words, a/an, its/it's, your/you're, then/than, could of, capital after a full stop.
- Japan-aware: romaji Japanese words (ramen, izakaya, Shinjuku…) aren't flagged; l/r and b/v mix-ups are suggested first; common sign mix-ups like "flied rice".
- Text panel with highlights, fix-all, copy corrected text, share/save the annotated PNG.
- History and personal dictionary stored locally (IndexedDB). Free, no ads, no login, no analytics. Photos never leave the device.

Credits: Tesseract.js (Apache-2.0), nspell (MIT), Hunspell dictionaries from wooorm/dictionaries (en: MIT/BSD-style SCOWL licence). App code: MIT.
