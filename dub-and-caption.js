/**
 * dub-and-caption.js
 * Input: short_video.mp4 (already-cut viral short, from recap-to-short.js)
 * Output: final_output.mp4
 *   - watermark removed
 *   - mirror flipped
 *   - converted to 9:16 vertical (TikTok/Shorts format) with blurred background padding
 *   - original audio replaced with Burmese AI voice narration (via edge-tts, free, no quota)
 *   - Burmese/English dual-language subtitles burned in
 *
 * Requirements:
 *   npm install @google/genai
 *   ffmpeg + ffprobe installed
 *   Noto Sans Myanmar font installed on the system (for subtitle rendering)
 *   edge-tts installed (pip install edge-tts) — free, no API key needed
 *
 * Env vars required:
 *   GEMINI_API_KEY
 *
 * Optional env vars:
 *   EDGE_TTS_VOICE  (default: my-MM-ThihaNeural — male Burmese voice.
 *                    use my-MM-NilarNeural for a female voice)
 *
 * Usage:
 *   node dub-and-caption.js short_video.mp4 final_output.mp4
 *
 * NOTE ON WATERMARK COORDINATES:
 *   The delogo box below (x=1000,y=580,w=280,h=50 for a 1280x720 video) was
 *   estimated from sample frames. If the watermark isn't fully covered or
 *   too much picture is blurred, adjust WATERMARK_BOX below and re-run.
 */

const { GoogleGenAI } = require("@google/genai");
const { execSync, execFileSync } = require("child_process");
const fs = require("fs");
const path = require("path");

const [, , INPUT_PATH, OUTPUT_PATH = "final_output.mp4"] = process.argv;
if (!INPUT_PATH) {
  console.error("Usage: node dub-and-caption.js <short_video.mp4> [final_output.mp4]");
  process.exit(1);
}

// Adjust this box to match where the watermark actually sits on your video.
// x,y = top-left corner; w,h = width/height of the box to blend out.
const WATERMARK_BOX = { x: 1000, y: 580, w: 280, h: 50 };

const EDGE_TTS_VOICE = process.env.EDGE_TTS_VOICE || "my-MM-ThihaNeural";

async function main() {
  const tmpDir = fs.mkdtempSync("/tmp/dub-");
  const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });

  // ---- 1. Upload video to Gemini and get a narration script with timing ----
  console.log("Uploading video to Gemini...");
  const uploaded = await ai.files.upload({
    file: INPUT_PATH,
    config: { mimeType: "video/mp4" },
  });
  let file = await ai.files.get({ name: uploaded.name });
  while (file.state === "PROCESSING") {
    process.stdout.write(".");
    await new Promise((r) => setTimeout(r, 3000));
    file = await ai.files.get({ name: uploaded.name });
  }
  if (file.state === "FAILED") throw new Error("Gemini file processing failed.");
  console.log("\nGenerating Burmese narration script...");

  const prompt = `
This is a short recap-style video with no usable dialogue audio (it will be replaced).
Watch the video and write a natural Burmese voice-over narration that describes and dramatizes
what's happening on screen, suitable for a viral short-form recap video.

Rules:
- Break the narration into short cues of 2-6 seconds each, covering almost the entire video duration.
- Cues must be in chronological order and must not overlap.
- "burmese" must be natural, spoken, conversational Burmese (not overly literal/formal), suitable for narration.
- "english" must be a natural English translation of the same line (not word-for-word, natural phrasing).
- Timestamps in MM:SS format, relative to this video.

Return ONLY valid JSON, no markdown, no explanation, in this exact shape:
[{"start":"MM:SS","end":"MM:SS","burmese":"...","english":"..."}]
`.trim();

  const result = await ai.models.generateContent({
    model: "gemini-2.5-flash-lite",
    contents: [
      {
        role: "user",
        parts: [
          { fileData: { fileUri: file.uri, mimeType: file.mimeType } },
          { text: prompt },
        ],
      },
    ],
    config: {
      responseMimeType: "application/json",
      maxOutputTokens: 8192,
      thinkingConfig: { thinkingBudget: 1024 },
    },
  });

  const responseText = result.text;
  if (!responseText) {
    console.error("Gemini returned no text. Full response:");
    console.error(JSON.stringify(result, null, 2));
    const candidate = result.candidates && result.candidates[0];
    const finishReason = candidate && candidate.finishReason;
    throw new Error(
      `Gemini returned empty text (finishReason: ${finishReason || "unknown"}). See logged response above.`
    );
  }

  const rawText = responseText.trim().replace(/^```json|```$/g, "").trim();
  let cues;
  try {
    cues = JSON.parse(rawText);
  } catch (e) {
    console.error("Strict JSON.parse failed, attempting recovery from truncated output...");
    cues = recoverJsonArray(rawText);
    if (!cues || cues.length === 0) {
      console.error("Recovery failed. Raw text was:\n", rawText);
      throw e;
    }
    console.warn(`Recovered ${cues.length} complete cue(s) from truncated response.`);
  }
  console.log(`Got ${cues.length} narration cues.`);
  fs.writeFileSync(path.join(tmpDir, "cues.json"), JSON.stringify(cues, null, 2));

  // ---- 2. Generate Burmese TTS audio per cue, time-stretched to fit its slot ----
  console.log(`Generating Burmese voice-over with edge-tts (voice: ${EDGE_TTS_VOICE})...`);
  const audioClips = []; // { path, startSeconds, durationSeconds }

  for (let i = 0; i < cues.length; i++) {
    const cue = cues[i];
    const startSec = toSeconds(cue.start);
    const endSec = toSeconds(cue.end);
    const slotDuration = Math.max(0.5, endSec - startSec);

    const rawMp3 = path.join(tmpDir, `voice_raw_${i}.mp3`);
    edgeTTS(cue.burmese, rawMp3);

    const rawDuration = getDuration(rawMp3);
    const fittedWav = path.join(tmpDir, `voice_fit_${i}.wav`);
    fitAudioToSlot(rawMp3, rawDuration, slotDuration, fittedWav);

    audioClips.push({ path: fittedWav, startSeconds: startSec });
    process.stdout.write(".");
  }
  console.log("\nVoice-over generation done.");

  // ---- 3. Build the full narration track (silence + each clip placed at its start time) ----
  const videoDuration = getDuration(INPUT_PATH);
  const narrationTrack = path.join(tmpDir, "narration.wav");
  buildNarrationTrack(audioClips, videoDuration, narrationTrack, tmpDir);

  // ---- 4. Build subtitle file (Burmese + English, two lines per cue) ----
  const srtPath = path.join(tmpDir, "captions.srt");
  buildSrt(cues, srtPath);

  // ---- 5. Final ffmpeg pass: delogo watermark, mirror flip, vertical TikTok format,
  //         burn subtitles, mux new audio ----
  console.log("Rendering final video (delogo + mirror + 9:16 vertical + subtitles + dub)...");
  const { x, y, w, h } = WATERMARK_BOX;
  const escapedSrt = srtPath.replace(/:/g, "\\:");
  const subtitleStyle =
    "FontName=Noto Sans Myanmar,FontSize=26,PrimaryColour=&HFFFFFF&,OutlineColour=&H000000&,BorderStyle=1,Outline=3,Alignment=2,MarginV=90";

  const filterComplex = [
    // remove watermark, then mirror the whole frame
    `[0:v]delogo=x=${x}:y=${y}:w=${w}:h=${h}:show=0,hflip[clean]`,
    // duplicate: one copy becomes a blurred, cropped-to-fill background;
    // the other stays full-frame and sits on top, centered
    `[clean]split=2[bgsrc][fgsrc]`,
    `[bgsrc]scale=1080:1920:force_original_aspect_ratio=increase,crop=1080:1920,boxblur=25:8[bg]`,
    `[fgsrc]scale=1080:-2[fg]`,
    `[bg][fg]overlay=(W-w)/2:(H-h)/2[stacked]`,
    // burn subtitles on the final 1080x1920 canvas
    `[stacked]subtitles='${escapedSrt}':force_style='${subtitleStyle}'[v]`,
  ].join(";");

  execSync(
    `ffmpeg -y -i "${INPUT_PATH}" -i "${narrationTrack}" ` +
      `-filter_complex "${filterComplex}" ` +
      `-map "[v]" -map 1:a ` +
      `-c:v libx264 -crf 20 -preset veryfast -c:a aac -shortest "${OUTPUT_PATH}"`,
    { stdio: "inherit" }
  );

  console.log(`\nDone. Final 9:16 dubbed + captioned video: ${OUTPUT_PATH}`);
}

// ---------- helpers ----------

function toSeconds(mmss) {
  const [m, s] = mmss.split(":").map(Number);
  return m * 60 + s;
}

function srtTimestamp(totalSeconds) {
  const h = String(Math.floor(totalSeconds / 3600)).padStart(2, "0");
  const m = String(Math.floor((totalSeconds % 3600) / 60)).padStart(2, "0");
  const s = String(Math.floor(totalSeconds % 60)).padStart(2, "0");
  const ms = String(Math.round((totalSeconds % 1) * 1000)).padStart(3, "0");
  return `${h}:${m}:${s},${ms}`;
}

function getDuration(filePath) {
  const out = execSync(
    `ffprobe -v error -show_entries format=duration -of default=noprint_wrappers=1:nokey=1 "${filePath}"`
  )
    .toString()
    .trim();
  return parseFloat(out);
}

function edgeTTS(text, outPath) {
  // Write text to a temp file to avoid shell-escaping issues with Burmese
  // Unicode text and punctuation, then let edge-tts read it with --file.
  const textFile = outPath + ".txt";
  fs.writeFileSync(textFile, text, "utf8");
  execFileSync(
    "edge-tts",
    ["--voice", EDGE_TTS_VOICE, "--file", textFile, "--write-media", outPath],
    { stdio: "ignore" }
  );
}

function fitAudioToSlot(inputPath, rawDuration, slotDuration, outPath) {
  // atempo only supports 0.5x-2x per filter instance; clamp to that range.
  let factor = rawDuration / slotDuration;
  factor = Math.max(0.5, Math.min(2.0, factor));
  execSync(
    `ffmpeg -y -i "${inputPath}" -filter:a "atempo=${factor.toFixed(3)}" -ar 44100 -ac 2 "${outPath}"`,
    { stdio: "ignore" }
  );
}

function buildNarrationTrack(clips, totalDuration, outPath, tmpDir) {
  // Build a silent base, then overlay each clip at its start offset using adelay + amix.
  const inputs = clips.map((c) => `-i "${c.path}"`).join(" ");
  const delayFilters = clips
    .map(
      (c, i) =>
        `[${i}:a]adelay=${Math.round(c.startSeconds * 1000)}|${Math.round(
          c.startSeconds * 1000
        )}[a${i}]`
    )
    .join(";");
  const mixInputs = clips.map((_, i) => `[a${i}]`).join("");
  const filterComplex = `${delayFilters};${mixInputs}amix=inputs=${clips.length}:duration=longest:dropout_transition=0[aout]`;

  execSync(
    `ffmpeg -y ${inputs} -filter_complex "${filterComplex}" -map "[aout]" -t ${totalDuration} "${outPath}"`,
    { stdio: "inherit" }
  );
}

function buildSrt(cues, outPath) {
  const lines = cues
    .map((cue, i) => {
      const start = srtTimestamp(toSeconds(cue.start));
      const end = srtTimestamp(toSeconds(cue.end));
      return `${i + 1}\n${start} --> ${end}\n${cue.burmese}\n${cue.english}\n`;
    })
    .join("\n");
  fs.writeFileSync(outPath, lines, "utf8");
}

// Recovers as many complete {...} objects as possible from a truncated JSON
// array string like '[{"a":1},{"b":2},{"c":' by scanning brace depth and
// dropping the last, incomplete object.
function recoverJsonArray(rawText) {
  const objects = [];
  let depth = 0;
  let startIdx = -1;
  for (let i = 0; i < rawText.length; i++) {
    const ch = rawText[i];
    if (ch === "{") {
      if (depth === 0) startIdx = i;
      depth++;
    } else if (ch === "}") {
      depth--;
      if (depth === 0 && startIdx !== -1) {
        const candidate = rawText.slice(startIdx, i + 1);
        try {
          objects.push(JSON.parse(candidate));
        } catch (_) {
          // skip malformed object
        }
        startIdx = -1;
      }
    }
  }
  return objects;
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
