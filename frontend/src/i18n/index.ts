// src/i18n/index.ts — dictionary aggregation (TRD §14.2).
import { common } from './dicts/common';
import { auth } from './dicts/auth';
import { post } from './dicts/post';
import { thread } from './dicts/thread';
import { workspace } from './dicts/workspace';
import { profile } from './dicts/profile';
import { errors } from './dicts/errors';

export const DICTS = { common, auth, post, thread, workspace, profile, errors } as const;
export type { Lang } from '../stores/langStore';
