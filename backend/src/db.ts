// backend/src/db.ts
// 단일 공유 PrismaClient. 앱 전역에서 이 인스턴스만 import 해 사용한다.
// (다중 인스턴스 생성으로 인한 커넥션 누수/핫리로드 중복 방지)

import { PrismaClient } from '@prisma/client';

export const prisma = new PrismaClient();
