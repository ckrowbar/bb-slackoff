// Slack attachments → BB prompt input. Images and files upload to the
// project's attachments; voice memos are transcribed so a phone can talk to
// the agent.
import { z } from "zod";

import { errorText, type PromptInput, type Sdk } from "./bb.ts";
import { isTrustedSlackFileUrl } from "./slack/api.ts";
import type { SlackClient } from "./slack/outbox.ts";

export const SlackFileSchema = z.object({
  id: z.string(),
  name: z.string().nullish(),
  title: z.string().nullish(),
  mimetype: z.string().default("application/octet-stream"),
  subtype: z.string().optional(),
  size: z.number().default(0),
  url_private: z.string().optional(),
  url_private_download: z.string().optional(),
  transcription: z
    .object({
      status: z.string().optional(),
      preview: z.object({ content: z.string().optional(), has_more: z.boolean().optional() }).optional(),
    })
    .optional(),
});
export type SlackFile = z.infer<typeof SlackFileSchema>;

const MAX_FILES = 10;
const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
const MAX_FILE_BYTES = 25 * 1024 * 1024;

export interface CollectedFiles {
  inputs: PromptInput[];
  /** Voice memo transcripts, in message order. */
  transcripts: string[];
  /** Human-readable reasons for files that were skipped. */
  skipped: string[];
}

export function isVoiceMemo(file: SlackFile): boolean {
  return file.subtype === "slack_audio" || file.mimetype.startsWith("audio/");
}

export async function collectFiles(input: { files: readonly SlackFile[]; projectId: string; slack: SlackClient; sdk: Sdk }): Promise<CollectedFiles> {
  const result: CollectedFiles = { inputs: [], transcripts: [], skipped: [] };
  for (const file of input.files) {
    const name = file.name || file.title || file.id;
    const url = file.url_private_download ?? file.url_private;
    const image = file.mimetype.startsWith("image/");
    const limit = image ? MAX_IMAGE_BYTES : MAX_FILE_BYTES;
    if (result.inputs.length + result.transcripts.length >= MAX_FILES) {
      result.skipped.push(`${name} (only ${MAX_FILES} files per message)`);
      continue;
    }
    if (file.size > limit) {
      result.skipped.push(`${name} (larger than ${limit / 1024 / 1024} MB)`);
      continue;
    }
    if (!url || !isTrustedSlackFileUrl(url)) {
      result.skipped.push(`${name} (Slack gave no download link)`);
      continue;
    }
    let bytes: Uint8Array;
    try {
      bytes = await input.slack.download(url, limit);
    } catch (error) {
      result.skipped.push(`${name} (${errorText(error)})`);
      continue;
    }

    if (isVoiceMemo(file)) {
      const transcript = await transcribe(input.sdk, bytes, file);
      if (transcript) {
        result.transcripts.push(transcript);
        continue;
      }
      // Without a transcript, the recording still reaches the agent as a file.
    }

    try {
      const uploaded = await input.sdk.projects.attachments.upload({
        projectId: input.projectId,
        clientFile: bytes,
        filename: name,
        mimeType: file.mimetype,
      });
      result.inputs.push(
        uploaded.type === "localImage"
          ? { type: "localImage", path: uploaded.path }
          : {
              type: "localFile",
              path: uploaded.path,
              name: uploaded.name,
              sizeBytes: uploaded.sizeBytes,
              ...(uploaded.mimeType ? { mimeType: uploaded.mimeType } : {}),
            },
      );
    } catch (error) {
      result.skipped.push(`${name} (${errorText(error)})`);
    }
  }
  return result;
}

async function transcribe(sdk: Sdk, bytes: Uint8Array, file: SlackFile): Promise<string | undefined> {
  try {
    const { text } = await sdk.system.transcribeVoice({ file: new Blob([bytes as BlobPart], { type: file.mimetype }) });
    if (text.trim()) return text.trim();
  } catch {
    // Fall back to Slack's own transcript below.
  }
  const preview = file.transcription?.preview;
  return file.transcription?.status === "complete" && preview?.content && !preview.has_more ? preview.content.trim() : undefined;
}
