import JSZip from 'jszip';
import {
  saveRecording,
  loadRecording,
  getAllRecordings,
  type StoredRecording,
} from './storage';

interface Manifest {
  formatVersion: 1;
  exportedAt: string;
  recordingCount: number;
}

// StoredRecording as it appears inside recording.json: the video Blob can't be
// JSON-serialized, so it's replaced with a reference to the zip entry that
// holds the raw bytes (original.webm / original.<ext>).
interface ExportedRecordingMeta extends Omit<StoredRecording, 'originalVideo'> {
  originalVideo?: { mimeType: string; filename: string };
}

export interface ImportOptions {
  overwrite: boolean;
}

export interface ImportResult {
  imported: number;
  skipped: number;
  errors: string[];
}

function slugify(label: string): string {
  const slug = label.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  return slug || 'recording';
}

function downloadBlob(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  link.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function toExportedMeta(recording: StoredRecording): ExportedRecordingMeta {
  const { originalVideo, ...rest } = recording;
  return {
    ...rest,
    ...(originalVideo ? { originalVideo: { mimeType: originalVideo.mimeType, filename: originalVideo.filename } } : {}),
  };
}

async function addRecordingToZip(zip: JSZip, recording: StoredRecording, basePath = ''): Promise<void> {
  zip.file(`${basePath}recording.json`, JSON.stringify(toExportedMeta(recording)));
  if (recording.originalVideo) {
    zip.file(`${basePath}${recording.originalVideo.filename}`, recording.originalVideo.blob);
  }
}

export async function exportRecording(id: string): Promise<void> {
  const recording = await loadRecording(id);
  if (!recording) throw new Error(`Recording "${id}" not found`);

  const zip = new JSZip();
  const manifest: Manifest = { formatVersion: 1, exportedAt: new Date().toISOString(), recordingCount: 1 };
  zip.file('manifest.json', JSON.stringify(manifest));
  await addRecordingToZip(zip, recording);

  const blob = await zip.generateAsync({ type: 'blob' });
  downloadBlob(blob, `unnoticed-dance-${slugify(recording.label)}-${recording.id}.zip`);
}

export async function exportAllRecordings(): Promise<void> {
  const recordings = await getAllRecordings();
  if (recordings.length === 0) throw new Error('No recordings to export');

  const zip = new JSZip();
  const manifest: Manifest = { formatVersion: 1, exportedAt: new Date().toISOString(), recordingCount: recordings.length };
  zip.file('manifest.json', JSON.stringify(manifest));

  for (const recording of recordings) {
    await addRecordingToZip(zip, recording, `recordings/${recording.id}/`);
  }

  const blob = await zip.generateAsync({ type: 'blob' });
  downloadBlob(blob, `unnoticed-dance-export-${Date.now()}.zip`);
}

function newImportedId(): string {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

async function readRecordingEntry(zip: JSZip, metaPath: string, dir: string): Promise<StoredRecording> {
  const metaFile = zip.file(metaPath);
  if (!metaFile) throw new Error(`Missing ${metaPath} in import file`);

  const { originalVideo: videoMeta, ...meta } = JSON.parse(await metaFile.async('string')) as ExportedRecordingMeta;
  const recording: StoredRecording = { ...meta };

  if (videoMeta) {
    const videoFile = zip.file(`${dir}${videoMeta.filename}`);
    if (!videoFile) throw new Error(`Missing video file "${videoMeta.filename}" for recording "${meta.id}"`);
    const blob = await videoFile.async('blob');
    recording.originalVideo = { blob, mimeType: videoMeta.mimeType, filename: videoMeta.filename };
  }

  return recording;
}

export async function importRecordingsFromFile(file: File, options: ImportOptions): Promise<ImportResult> {
  const result: ImportResult = { imported: 0, skipped: 0, errors: [] };

  let zip: JSZip;
  try {
    zip = await JSZip.loadAsync(file);
  } catch (error) {
    result.errors.push(`Could not read "${file.name}" as a zip file`);
    return result;
  }

  const isBulk = Object.keys(zip.files).some((path) => /^recordings\/[^/]+\/recording\.json$/.test(path));

  let entries: { metaPath: string; dir: string }[];
  if (isBulk) {
    entries = Object.keys(zip.files)
      .filter((path) => /^recordings\/[^/]+\/recording\.json$/.test(path))
      .map((metaPath) => ({ metaPath, dir: metaPath.slice(0, metaPath.length - 'recording.json'.length) }));
  } else if (zip.file('recording.json')) {
    entries = [{ metaPath: 'recording.json', dir: '' }];
  } else {
    result.errors.push('No recording.json found in import file');
    return result;
  }

  const existingIds = new Set((await getAllRecordings()).map((item) => item.id));

  for (const { metaPath, dir } of entries) {
    try {
      const recording = await readRecordingEntry(zip, metaPath, dir);

      if (existingIds.has(recording.id)) {
        if (options.overwrite) {
          await saveRecording(recording);
          result.imported += 1;
        } else {
          recording.id = newImportedId();
          recording.label = `${recording.label} (imported)`;
          await saveRecording(recording);
          existingIds.add(recording.id);
          result.imported += 1;
        }
      } else {
        await saveRecording(recording);
        existingIds.add(recording.id);
        result.imported += 1;
      }
    } catch (error) {
      result.skipped += 1;
      const message = error instanceof Error ? error.message : String(error);
      result.errors.push(`${metaPath}: ${message}`);
      console.warn(`Failed to import recording from ${metaPath}:`, error);
    }
  }

  return result;
}
