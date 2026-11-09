/**
 * Photos from expo-image-picker into the composer. `useAttachments().add()` (from @uncage/react)
 * validates and uploads `Blob & { name }` like a browser `File`. The picker copies the photo into
 * the app's cache and hands over a `file://` URI; the global fetch (expo/fetch in SDK 58+) reads it
 * into a Blob, which is then named. expo/fetch does not read `content://` URIs: copy such files to
 * a file first. The upload sends the Blob as the request body.
 */

/** The fields of an `ImagePickerAsset` used here. */
export interface PickedAsset {
  uri: string;
  fileName?: string | null;
  mimeType?: string | null;
}

const EXT_BY_MIME: Record<string, string> = {
  'image/jpeg': 'jpg',
  'image/jpg': 'jpg',
  'image/png': 'png',
  'image/gif': 'gif',
  'image/webp': 'webp',
};

/**
 * A file name with an extension that matches the image type (the hub classifies by both). The
 * picker may give no name (iOS) or an extension that no longer fits after conversion to JPEG.
 */
export function pickedFileName(asset: PickedAsset, index = 0, now: number = Date.now()): string {
  const mime = asset.mimeType?.toLowerCase().split(';')[0]?.trim();
  const ext = (mime && EXT_BY_MIME[mime]) ?? asset.uri.split(/[?#]/)[0]!.split('.').pop()?.toLowerCase() ?? 'jpg';
  const fromPicker = asset.fileName?.trim().replace(/[/\\]/g, '_');
  const base = fromPicker ? fromPicker.replace(/\.[^.]*$/, '') : `photo-${now}${index > 0 ? `-${index}` : ''}`;
  return `${base || 'photo'}.${ext && /^[a-z0-9]{1,5}$/.test(ext) ? ext : 'jpg'}`;
}

/** Reads a picked asset into a named Blob for `useAttachments().add()`. */
export async function assetToFile(asset: PickedAsset, fetchImpl: typeof fetch, index = 0): Promise<Blob & { name: string }> {
  const res = await fetchImpl(asset.uri);
  const blob = await res.blob();
  Object.defineProperty(blob, 'name', { value: pickedFileName(asset, index), enumerable: true });
  // The store needs only `name`, `size` and `type`: React Native has no File, a named Blob does.
  return blob as Blob & { name: string };
}
