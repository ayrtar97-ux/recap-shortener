/**
 * recap-to-short.js
 * Input: 15-30 min movie recap video (.mp4)
 * Output: 3-5 min viral short video (segments picked by Gemini, cut + joined by ffmpeg)
 *
 * Requirements:
 *   npm install @google/genai
 *   ffmpeg must be installed on the system (or in the GitHub Actions runner)
 *
 * Usage:
 *   GEMINI_API_KEY=xxxx node recap-to-short.js input.mp4 output.mp4
 */

const { GoogleGenAI } = require("@google/genai");
const { execSync } = require("child_process");
const fs = require("fs");
const path = require("path");

const [, , INPUT_PATH, OUTPUT_PATH = "short_output.mp4"] = process.argv;

if (!INPUT_PATH) {
  console.error("Usage: node recap-to-short.js <input.mp4> [output.mp4]");
  process.exit(1);
}

const TARGET_MIN_SECONDS = 180; // 3 min
const TARGET_MAX_SECONDS = 300; // 5 min

// Retries a Gemini call on transient errors (503 overloaded, 429 rate-limited)
// with exponential backoff. Does not retry on other errors (e.g. bad request).
async function withRetry(fn, { retries = 8, baseDelayMs = 5000, maxDelayMs = 60000 } = {}) {
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      return await fn();
    } catch (err) {
      const status = err && (err.status || (err.error && err.error.code));
      const isTransient = status === 503 || status === 429;
      if (!isTransient || attempt === retries) throw err;
      const delay = Math.min(baseDelayMs * Math.pow(2, attempt - 1), maxDelayMs);
      console.warn(
        `Gemini call failed (status ${status}), retrying in ${delay / 1000}s... (attempt ${attempt}/${retries})`
      );
      await new Promise((r) => setTimeout(r, delay));
    }
  }
}

async function main() {
  const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });

  // 1. Upload the recap video to Gemini's File API
  console.log("Uploading video to Gemini...");
  const uploaded = await ai.files.upload({
    file: INPUT_PATH,
    config: { mimeType: "video/mp4" },
  });

  // Wait until the file finishes processing
  let file = await ai.files.get({ name: uploaded.name });
  while (file.state === "PROCESSING") {
    process.stdout.write(".");
    await new Promise((r) => setTimeout(r, 3000));
    file = await ai.files.get({ name: uploaded.name });
  }
  if (file.state === "FAILED") throw new Error("Gemini file processing failed.");
  console.log("\nUpload done. Analyzing video...");

  // 2. Ask Gemini to pick the most viral-worthy segments
  const prompt = `
This is a movie recap video. Select the ${Math.round(
    TARGET_MIN_SECONDS / 60
  )}-${Math.round(
    TARGET_MAX_SECONDS / 60
  )} minutes worth of the MOST viral, attention-grabbing, emotionally intense, or plot-twist moments.

Rules:
- Return 4 to 7 non-overlapping segments.
- Each segment should be a natural clip (don't cut mid-sentence if avoidable).
- Total combined duration must be between ${TARGET_MIN_SECONDS} and ${TARGET_MAX_SECONDS} seconds.
- Prioritize: shocking reveals, action peaks, emotional climax, cliffhangers, funniest/most quotable lines.
- Timestamps must use MM:SS format relative to this video.

HOOK REQUIREMENT (critical for virality):
- The FIRST segment in your returned list must be the single most scroll-stopping,
  jaw-dropping, or intriguing 3-6 seconds in the entire video — something that makes
  someone stop scrolling within the first 2 seconds (a shocking visual, a scream, a
  gunshot, a huge reveal, a dramatic slap, an explosion, etc).
- This hook segment does NOT need to be from the actual start of the movie
  chronologically — pick it from anywhere. It will be played first, and the
  remaining segments will follow in their normal chronological order after it.
- If the true chronological opening is already the strongest hook, it's fine to
  keep it first — but actively consider later/climactic moments as the hook too.

Return ONLY valid JSON, no markdown, no explanation, in this exact shape:
[{"start":"MM:SS","end":"MM:SS","reason":"short reason","is_hook":true|false}]
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
  let segments;
  try {
    segments = JSON.parse(rawText);
  } catch (e) {
    console.error("Strict JSON.parse failed, attempting recovery from truncated output...");
    segments = recoverJsonArray(rawText);
    if (!segments || segments.length === 0) {
      console.error("Recovery failed. Raw text was:\n", rawText);
      throw e;
    }
    console.warn(`Recovered ${segments.length} complete segment(s) from truncated response.`);
  }
  console.log("Selected segments:", segments);

  // 3. Cut each segment from the ORIGINAL (full quality) video with ffmpeg
  const tmpDir = fs.mkdtempSync("/tmp/recap-");
  const clipPaths = [];

  segments.forEach((seg, i) => {
    const clipPath = path.join(tmpDir, `clip_${i}.mp4`);
    // Re-encode (not -c copy) so cuts land on exact timestamps, not just keyframes
    execSync(
      `ffmpeg -y -i "${INPUT_PATH}" -ss ${toSeconds(seg.start)} -to ${toSeconds(
        seg.end
      )} -c:v libx264 -crf 20 -preset veryfast -c:a aac "${clipPath}"`,
      { stdio: "inherit" }
    );
    clipPaths.push(clipPath);
  });

  // 4. Concatenate all clips into the final short video
  const listFile = path.join(tmpDir, "list.txt");
  fs.writeFileSync(listFile, clipPaths.map((p) => `file '${p}'`).join("\n"));

  execSync(
    `ffmpeg -y -f concat -safe 0 -i "${listFile}" -c:v libx264 -crf 20 -preset veryfast -c:a aac "${OUTPUT_PATH}"`,
    { stdio: "inherit" }
  );

  console.log(`\nDone. Short video saved to: ${OUTPUT_PATH}`);
  console.log(
    "Next: transcribe + voice over + subtitles (your own pipeline) on this output file."
  );
}

function toSeconds(mmss) {
  const [m, s] = mmss.split(":").map(Number);
  return m * 60 + s;
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
