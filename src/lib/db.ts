import { Job, JobFile, SyncTask } from '@/types';
import Dexie, { Table } from 'dexie';

class MetaExtractDB extends Dexie {
  jobs!: Table<Job>;
  files!: Table<JobFile>;
  syncTasks!: Table<SyncTask>;
  
  constructor() {
    super('Metascreener-db');
    this.version(1).stores({
      jobs: '++id, name, status, created, batchId',
      files : '++id, jobId, filename, file',
    });
    this.version(2).stores({
      jobs: '++id, name, status, created, batchId',
      files : '++id, jobId, filename',
      syncTasks: '++id, jobId, [jobId+model], [jobId+status]',
    });
  }
}

export const db = new MetaExtractDB();
