import { Zip, ZipDeflate } from 'fflate';

export interface ZipEntry {
  path: string;
  data: () => Promise<Uint8Array | AsyncIterable<Uint8Array>>;
}

/**
 * A ZIP built while it is read: each entry is compressed as it is pulled, so large exports never
 * sit in memory whole. Errors while reading an entry abort the stream.
 */
export function zipStream(entries: Iterable<ZipEntry>): ReadableStream<Uint8Array> {
  const pending = [...entries];
  let zip: Zip;
  let ended = false;
  return new ReadableStream<Uint8Array>({
    start(controller) {
      zip = new Zip((error, chunk, final) => {
        if (error) return controller.error(error);
        controller.enqueue(chunk);
        if (final) controller.close();
      });
    },
    // One entry per pull, so a slow reader slows the export down instead of buffering it.
    async pull(controller) {
      if (ended) return;
      const entry = pending.shift();
      if (!entry) {
        ended = true;
        zip.end();
        return;
      }
      try {
        const file = new ZipDeflate(entry.path, { level: 6 });
        zip.add(file);
        const data = await entry.data();
        if (data instanceof Uint8Array) {
          file.push(data, true);
        } else {
          for await (const chunk of data) file.push(chunk);
          file.push(new Uint8Array(0), true);
        }
      } catch (error) {
        zip.terminate();
        controller.error(error);
      }
    },
    cancel() {
      zip.terminate();
    },
  });
}
