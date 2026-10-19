import { Unzip, UnzipInflate, UnzipPassThrough, type UnzipFile } from "fflate";

export const MAX_TEXT_EXPORT_BYTES = 1_500_000;
export const MAX_ZIP_EXPORT_BYTES = 50_000_000;

function isChatTextFile(name: string): boolean {
  const normalized = name.replace(/\\/g, "/");
  const baseName = normalized.slice(normalized.lastIndexOf("/") + 1);
  return (
    baseName.toLowerCase().endsWith(".txt") &&
    baseName.length > 4 &&
    !normalized.startsWith("__MACOSX/") &&
    !baseName.startsWith(".")
  );
}

export function extractWhatsAppTextFromZip(archive: Uint8Array): Promise<string> {
  if (archive.byteLength > MAX_ZIP_EXPORT_BYTES) {
    return Promise.reject(new Error("This ZIP is over 50 MB. Export the chat without media and try again."));
  }

  return new Promise((resolve, reject) => {
    let candidateCount = 0;
    let extractedText: string | null = null;
    let extractionFinished = false;
    let settled = false;
    let totalBytes = 0;
    const chunks: Uint8Array[] = [];
    let chatFile: UnzipFile | null = null;

    const fail = (message: string) => {
      if (settled) return;
      settled = true;
      chatFile?.terminate();
      reject(new Error(message));
    };

    const unzip = new Unzip((file) => {
      if (!isChatTextFile(file.name)) return;

      candidateCount += 1;
      if (candidateCount > 1) {
        fail("This ZIP contains more than one .txt file. Choose an archive with one WhatsApp chat export.");
        return;
      }
      if (
        file.originalSize !== undefined &&
        file.originalSize > MAX_TEXT_EXPORT_BYTES
      ) {
        fail("The chat text in this ZIP is over 1.5 MB. Export the chat without media and try again.");
        return;
      }
      if (file.compression !== 0 && file.compression !== 8) {
        fail("This ZIP uses a compression format we can’t read. Create a standard ZIP export and try again.");
        return;
      }

      chatFile = file;
      file.ondata = (error, chunk, final) => {
        if (error) {
          fail("We couldn’t read the ZIP archive. Create a fresh WhatsApp export and try again.");
          return;
        }

        totalBytes += chunk.byteLength;
        if (totalBytes > MAX_TEXT_EXPORT_BYTES) {
          fail("The chat text in this ZIP is over 1.5 MB. Export the chat without media and try again.");
          return;
        }

        if (chunk.byteLength > 0) chunks.push(chunk);
        if (final) {
          extractedText = new TextDecoder("utf-8").decode(
            concatenateChunks(chunks, totalBytes),
          );
          extractionFinished = true;
        }
      };

      try {
        file.start();
      } catch {
        fail("We couldn’t decompress this ZIP. Create a fresh WhatsApp export and try again.");
      }
    });

    unzip.register(UnzipInflate);
    unzip.register(UnzipPassThrough);

    try {
      unzip.push(archive, true);
    } catch {
      fail("This ZIP appears to be damaged or unsupported. Create a fresh WhatsApp export and try again.");
      return;
    }

    if (settled) return;
    if (candidateCount === 0) {
      fail("We couldn’t find a .txt chat export in this ZIP.");
    } else if (candidateCount > 1) {
      fail("This ZIP contains more than one .txt file. Choose an archive with one WhatsApp chat export.");
    } else if (!extractionFinished || extractedText === null) {
      fail("We couldn’t extract the chat text. Create a fresh WhatsApp export and try again.");
    } else {
      settled = true;
      resolve(extractedText);
    }
  });
}

function concatenateChunks(chunks: Uint8Array[], length: number): Uint8Array {
  const result = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return result;
}
