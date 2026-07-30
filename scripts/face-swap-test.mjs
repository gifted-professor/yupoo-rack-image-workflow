#!/usr/bin/env node
// One-off test: can gpt-image-2 (edit mode) reproduce a specific face from a reference?
// Base = already-generated tryon image; face source = assets/model-faces/female-01.png.
import path from 'node:path';
import { loadLocalEnv, callImageBridge, saveGeneratedImage, writeJson, extensionFor, projectRoot } from './workflow-lib.mjs';

await loadLocalEnv();

const base = 'runs/rack-20260720T114210Z/review/HM9699-701-tryon_main.png';
const face = 'assets/model-faces/female-01.png';
const bridgeUrl = process.env.IMAGE_BRIDGE_URL || 'http://127.0.0.1:8907/api/image/generate';

// references order: [face source, base photo to edit]. Prompt references them by position.
const prompt = [
  'Edit the SECOND reference image (the in-store try-on photo of a woman wearing a Nike tee).',
  'Keep the garment, body, pose, framing, lighting, and background EXACTLY as in that second image.',
  'Replace ONLY the model\'s face so it matches the adult woman\'s face in the FIRST reference image (the polo-shirt studio photo).',
  'Match the first image\'s face shape, features, and skin tone; blend into the existing lighting. Same head tilt is fine.',
  'Do NOT change the clothing, the Nike logo, the crew neck, the short sleeves, the raglan seams, or the background.',
  'Output a single vertical phone-style photo.',
].join('\n');

const generated = await callImageBridge({
  bridgeUrl,
  prompt,
  type: '商品实体店试穿上身图',
  references: [face, base],
  sku: 'HM9699-701',
  verifiedFacts: [
    'The second reference image is the photo to edit; preserve its garment, pose, and setting.',
    'The first reference image is only a face source; copy its face onto the model.',
  ],
});

const ext = extensionFor(generated.mime);
const outRel = `runs/face-swap-test/hm701-tryon-main-faceswapped.${ext}`;
const out = await saveGeneratedImage(outRel, generated);
await writeJson('runs/face-swap-test/hm701-request.json', {
  prompt, base, face, model: generated.body.model, responsesModel: generated.body.responsesModel, elapsedMs: generated.elapsedMs, output: out,
});
console.log(JSON.stringify({ ok: true, output: out, elapsedMs: generated.elapsedMs, model: generated.body.model }, null, 2));