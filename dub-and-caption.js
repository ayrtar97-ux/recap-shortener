/**
 * dub-and-caption.js
 * Input: short_video.mp4 (already-cut viral short, from recap-to-short.js)
 * Output: final_output.mp4
 *   - watermark removed
 *   - mirror flipped
 *   - converted to 9:16 vertical (TikTok/Shorts format) with blurred background padding
 *   - original audio replaced with Burmese AI voice narration (via edge-tts, free, no quota)
 *   - bold, viral-style Burmese/English dual-language subtitles burned in
 *   - opening line written as a scroll-stopping hook
 *   - optional background music bed, quietly mixed under the narration
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
 *   BG_MUSIC_PATH   (path to a royalty-free mp3/wav to use as background music;
 *                    skipped entirely if unset or the file doesn't exist)
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
const WATERMARK_BOX = { x: 980, y: 570, w: 290, h: 60 };

const EDGE_TTS_VOICE = process.env.EDGE_TTS_VOICE || "my-MM-ThihaNeural";
// Speeds up the base narration pace a bit for punchier, more viral-style delivery.
// Format: "+15%" faster, "-10%" slower, "+0%" for edge-tts's natural default pace.
const EDGE_TTS_RATE = process.env.EDGE_TTS_RATE || "+15%";
// Optional: path to a royalty-free background music file (mp3/wav). If set and
// the file exists, it's looped, trimmed to video length, and mixed in quietly
// under the narration. Leave unset to skip background music entirely.
const BG_MUSIC_PATH = process.env.BG_MUSIC_PATH || null;

// Retries a Gemini call on transient errors (503 overloaded, 429 rate-limited)
// with exponential backoff. Does not retry on other errors (e.g. bad request).
async function withRetry(fn, { retries = 5, baseDelayMs = 5000 } = {}) {
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      return await fn();
    } catch (err) {
      const status = err && (err.status || (err.error && err.error.code));
      const isTransient = status === 503 || status === 429;
      if (!isTransient || attempt === retries) throw err;
      const delay = baseDelayMs * Math.pow(2, attempt - 1);
      console.warn(
        `Gemini call failed (status ${status}), retrying in ${delay / 1000}s... (attempt ${attempt}/${retries})`
      );
      await new Promise((r) => setTimeout(r, delay));
    }
  }
}

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
This is a short recap-style video made of several DISCONNECTED clips cut together from a
longer movie — the scenes jump around and are NOT continuous. There is no usable dialogue
audio (it will be replaced). Watch the video and write a natural Burmese voice-over
narration that describes what's happening AND actively bridges the gaps between clips so
the story feels connected rather than jumpy.

Rules:
- Break the narration into short cues of 2-6 seconds each, covering almost the entire video duration.
- Cues must be in chronological order and must not overlap.
- "burmese" must be natural, spoken, conversational Burmese (not overly literal/formal), suitable for narration.
- "english" must be a natural English translation of the same line (not word-for-word, natural phrasing).
- Timestamps in MM:SS format, relative to this video.

CONTINUITY REQUIREMENT (important — this is a recap made of disconnected clips):
- Every time the scene jumps to a new moment, the first cue for that new clip must
  include a brief connective/transitional phrase so the viewer isn't confused —
  e.g. "Later that night...", "Back at the station...", "Meanwhile, across town...",
  "Just when things seemed calm...". Don't just describe the new visual in isolation.
- Keep references to characters and their relationships consistent across cues (use
  the same name/role for the same person every time) so viewers can follow who's who
  even though they're only seeing fragments of the story.
- Briefly imply what connects this moment to the previous one (cause, consequence, or
  time jump) rather than treating each clip as a standalone caption.

HOOK REQUIREMENT (critical for virality):
- The very first cue (covering roughly the first 2-4 seconds) must be a punchy,
  scroll-stopping hook line — a rhetorical question, a bold claim, or a dramatic
  exclamation that matches the shocking visual on screen at that moment.
  Examples of hook energy (write your own, don't reuse these verbatim):
  "You won't believe what happens next..." / "This one decision destroys everything." /
  "Watch what they find inside." Keep it short and punchy, not a full explanation.
- After the hook line, continue with natural descriptive narration for the rest.

Return ONLY valid JSON, no markdown, no explanation, in this exact shape:
[{"start":"MM:SS","end":"MM:SS","burmese":"...","english":"..."}]
`.trim();

  const result = await withRetry(() =>
    ai.models.generateContent({
      model: "gemini-3.5-flash-lite",
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
    })
  );

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

  // ---- 3b. Optionally mix in background music, ducked quietly under the narration ----
  let finalAudioTrack = narrationTrack;
  if (BG_MUSIC_PATH && fs.existsSync(BG_MUSIC_PATH)) {
    console.log(`Mixing in background music from ${BG_MUSIC_PATH}...`);
    finalAudioTrack = path.join(tmpDir, "narration_with_music.wav");
    mixBackgroundMusic(narrationTrack, BG_MUSIC_PATH, videoDuration, finalAudioTrack);
  } else {
    console.log("No background music file found (set BG_MUSIC_PATH to enable). Skipping music.");
  }

  // ---- 4. Build subtitle file (Burmese + English, two lines per cue) ----
  const srtPath = path.join(tmpDir, "captions.srt");
  buildSrt(cues, srtPath);

  // ---- 5. Final ffmpeg pass: delogo watermark, mirror flip, vertical TikTok format,
  //         burn subtitles, mux new audio ----
  console.log("Rendering final video (delogo + mirror + 9:16 vertical + subtitles + dub)...");
  const { width: vidW, height: vidH } = getDimensions(INPUT_PATH);
  const { x, y, w, h } = clampBoxToFrame(WATERMARK_BOX, vidW, vidH);
  const escapedSrt = srtPath.replace(/:/g, "\\:");
  const subtitleStyle =
    "FontName=Arial,FontSize=34,Bold=1,PrimaryColour=&H00FFFF&,OutlineColour=&H000000&,BorderStyle=1,Outline=4,Shadow=1,Alignment=2,MarginV=320,PlayResX=1080,PlayResY=1920";

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
    `ffmpeg -y -i "${INPUT_PATH}" -i "${finalAudioTrack}" ` +
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

function getDimensions(filePath) {
  const out = execSync(
    `ffprobe -v error -select_streams v:0 -show_entries stream=width,height -of csv=s=x:p=0 "${filePath}"`
  )
    .toString()
    .trim();
  const [width, height] = out.split("x").map(Number);
  return { width, height };
}

// Ensures the delogo box has at least a 2px margin from every frame edge,
// scaling/shifting it down if needed. Prevents "Logo area is outside of the
// frame" errors when the box (estimated for one resolution) is reused on a
// differently-sized video, or sits exactly on the boundary.
function clampBoxToFrame(box, frameW, frameH) {
  const margin = 2;
  let { x, y, w, h } = box;
  w = Math.min(w, frameW - margin * 2);
  h = Math.min(h, frameH - margin * 2);
  x = Math.min(Math.max(x, 0), frameW - w - margin);
  y = Math.min(Math.max(y, 0), frameH - h - margin);
  return { x, y, w, h };
}

function edgeTTS(text, outPath) {
  // Write text to a temp file to avoid shell-escaping issues with Burmese
  // Unicode text and punctuation, then let edge-tts read it with --file.
  const textFile = outPath + ".txt";
  fs.writeFileSync(textFile, text, "utf8");
  execFileSync(
    "edge-tts",
    [
      "--voice", EDGE_TTS_VOICE,
      "--rate", EDGE_TTS_RATE,
      "--file", textFile,
      "--write-media", outPath,
    ],
    { stdio: "ignore" }
  );
}

function fitAudioToSlot(inputPath, rawDuration, slotDuration, outPath) {
  // Only speed up if the line runs longer than its slot — never artificially
  // slow the voice down to fill extra time, since that sounds unnaturally
  // draggy/slow. If the line is shorter than its slot, it just ends early
  // and the next line's silence naturally fills the gap.
  let factor = rawDuration / slotDuration;
  factor = Math.max(1.0, Math.min(2.0, factor));
  // Slightly lower the narration volume (was sounding too loud/harsh at full gain).
  execSync(
    `ffmpeg -y -i "${inputPath}" -filter:a "atempo=${factor.toFixed(3)},volume=0.8" -ar 44100 -ac 2 "${outPath}"`,
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

// Loops/trims a music file to match video length and mixes it in quietly
// (relative to the already-normal-volume narration track) so it sits as a
// bed under the voice-over rather than competing with it.
function mixBackgroundMusic(narrationPath, musicPath, totalDuration, outPath) {
  execSync(
    `ffmpeg -y -i "${narrationPath}" -stream_loop -1 -i "${musicPath}" ` +
      `-filter_complex "[1:a]volume=0.15,atrim=0:${totalDuration}[music];[0:a][music]amix=inputs=2:duration=first:dropout_transition=0[aout]" ` +
      `-map "[aout]" -t ${totalDuration} "${outPath}"`,
    { stdio: "inherit" }
  );
}

function buildSrt(cues, outPath) {
  const lines = cues
    .map((cue, i) => {
      const start = srtTimestamp(toSeconds(cue.start));
      const end = srtTimestamp(toSeconds(cue.end));
      return `${i + 1}\n${start} --> ${end}\n${cue.english}\n`;
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
