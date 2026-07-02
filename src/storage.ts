import { openDB, type DBSchema, type IDBPDatabase } from 'idb';

export interface PoseLandmark {
  x: number;
  y: number;
  z: number;
  visibility: number;
}

export interface HandLandmarks {
  // MediaPipe's own Left/Right label, mirrored for a front-facing selfie camera
  // (i.e. "Right" is the hand that visually appears on the left in a mirrored
  // self-view — this is MediaPipe's documented behavior, not a bug).
  left: PoseLandmark[] | null;
  right: PoseLandmark[] | null;
}

export interface PoseFrame {
  t: number;
  landmarks: PoseLandmark[];
  faceLandmarks: PoseLandmark[];
  handLandmarks?: HandLandmarks; // absent on recordings made before hand tracking was added
}

export interface StoredRecording {
  id: string;
  label: string;
  createdAt: string;
  duration: number;
  frames: PoseFrame[];
  // Populated when "Save original video" is checked; not present on older
  // recordings or ones saved without that option. getAllRecordings() loads
  // every recording's full Blob into memory to populate the list UI, which
  // is fine at prototype scale — a future optimization would move Blobs
  // into their own object store keyed by recording id, loaded on demand.
  originalVideo?: {
    blob: Blob;
    mimeType: string;
    filename: string;
  };
}

interface RecordingsDB extends DBSchema {
  recordings: {
    key: string;
    value: StoredRecording;
    indexes: { 'by-createdAt': string };
  };
}

const DB_NAME = 'unnoticed-dance-db';
const DB_VERSION = 1;
const STORE_NAME = 'recordings';
const LEGACY_LOCALSTORAGE_KEY = 'unnoticed-dance-recordings-v2';

let dbPromise: Promise<IDBPDatabase<RecordingsDB>> | null = null;

function getDB(): Promise<IDBPDatabase<RecordingsDB>> {
  if (!dbPromise) {
    dbPromise = openDB<RecordingsDB>(DB_NAME, DB_VERSION, {
      upgrade(db) {
        if (!db.objectStoreNames.contains(STORE_NAME)) {
          const store = db.createObjectStore(STORE_NAME, { keyPath: 'id' });
          store.createIndex('by-createdAt', 'createdAt');
        }
      },
    });
  }
  return dbPromise;
}

function wrapError(action: string, error: unknown): Error {
  const message = error instanceof Error ? error.message : String(error);
  console.warn(`${action}:`, error);
  return new Error(`${action}: ${message}`);
}

// One-time migration of recordings that were previously stored as a single
// JSON string in localStorage (which is what caused QuotaExceededError for
// long recordings). Runs at most once per session and is safe to call
// repeatedly; it becomes a no-op once the legacy key is gone.
let migrationPromise: Promise<void> | null = null;

function migrateFromLocalStorageOnce(): Promise<void> {
  if (!migrationPromise) {
    migrationPromise = (async () => {
      let raw: string | null = null;
      try {
        raw = window.localStorage.getItem(LEGACY_LOCALSTORAGE_KEY);
      } catch (error) {
        console.warn('Could not read legacy localStorage recordings:', error);
        return;
      }
      if (!raw) return;

      try {
        const legacyRecordings = JSON.parse(raw) as StoredRecording[];
        const db = await getDB();
        const tx = db.transaction(STORE_NAME, 'readwrite');
        await Promise.all([
          ...legacyRecordings.map((recording) => tx.store.put(recording)),
          tx.done,
        ]);
        window.localStorage.removeItem(LEGACY_LOCALSTORAGE_KEY);
      } catch (error) {
        console.warn('Failed to migrate recordings from localStorage to IndexedDB:', error);
      }
    })();
  }
  return migrationPromise;
}

export async function saveRecording(recording: StoredRecording): Promise<void> {
  await migrateFromLocalStorageOnce();
  try {
    const db = await getDB();
    await db.put(STORE_NAME, recording);
  } catch (error) {
    throw wrapError(`Failed to save recording "${recording.label}"`, error);
  }
}

export async function loadRecording(id: string): Promise<StoredRecording | undefined> {
  await migrateFromLocalStorageOnce();
  try {
    const db = await getDB();
    return await db.get(STORE_NAME, id);
  } catch (error) {
    throw wrapError(`Failed to load recording "${id}"`, error);
  }
}

export async function getAllRecordings(): Promise<StoredRecording[]> {
  await migrateFromLocalStorageOnce();
  try {
    const db = await getDB();
    const all = await db.getAll(STORE_NAME);
    return all.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  } catch (error) {
    throw wrapError('Failed to list recordings', error);
  }
}

export async function deleteRecording(id: string): Promise<void> {
  await migrateFromLocalStorageOnce();
  try {
    const db = await getDB();
    await db.delete(STORE_NAME, id);
  } catch (error) {
    throw wrapError(`Failed to delete recording "${id}"`, error);
  }
}
