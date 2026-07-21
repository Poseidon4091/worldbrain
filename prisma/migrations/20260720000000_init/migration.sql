-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "public";

-- CreateExtension
CREATE EXTENSION IF NOT EXISTS "vector";

-- CreateTable
CREATE TABLE "settings" (
    "userId" TEXT NOT NULL,
    "embeddingEnabled" BOOLEAN NOT NULL DEFAULT true,
    "embeddingRouter" TEXT NOT NULL DEFAULT 'openai',
    "embeddingModel" TEXT,
    "llmRouter" TEXT NOT NULL DEFAULT 'openai',
    "llmModel" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "settings_pkey" PRIMARY KEY ("userId")
);

-- CreateTable
CREATE TABLE "worlds" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "group_name" TEXT,
    "tags" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "readOnly" BOOLEAN NOT NULL DEFAULT false,
    "tagGated" BOOLEAN NOT NULL DEFAULT false,
    "checkpoint" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "worlds_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "world_items" (
    "id" TEXT NOT NULL,
    "worldId" TEXT NOT NULL,
    "sourceId" TEXT,
    "key" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "content" TEXT NOT NULL,
    "importanceScore" DOUBLE PRECISION NOT NULL DEFAULT 1.0,
    "canonBook" INTEGER,
    "canonChapter" INTEGER,
    "embedding" vector(1024),
    "embeddingModel" TEXT,
    "embeddedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "world_items_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "world_checkpoints" (
    "id" TEXT NOT NULL,
    "worldId" TEXT NOT NULL,
    "messageId" TEXT NOT NULL,
    "data" JSONB NOT NULL,
    "summary" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "world_checkpoints_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "memories" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "worldId" TEXT,
    "kind" TEXT NOT NULL DEFAULT 'fact',
    "status" TEXT NOT NULL DEFAULT 'ACCEPTED',
    "content" TEXT NOT NULL,
    "confidence" DOUBLE PRECISION,
    "reasoning" TEXT,
    "sourceMessageIds" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "actualTags" JSONB NOT NULL DEFAULT '[]',
    "suggestedTags" JSONB NOT NULL DEFAULT '[]',
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "deletedAt" TIMESTAMP(3),
    "metadata" JSONB NOT NULL DEFAULT '{}',
    "importanceScore" DOUBLE PRECISION NOT NULL DEFAULT 2.0,
    "referenceCount" INTEGER NOT NULL DEFAULT 1,
    "lastReferencedAt" TIMESTAMP(3),
    "parentMemoryId" TEXT,
    "embedding" vector(1024),
    "embeddingModel" TEXT,
    "embeddedAt" TIMESTAMP(3),

    CONSTRAINT "memories_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "worlds_userId_idx" ON "worlds"("userId");

-- CreateIndex
CREATE INDEX "world_items_worldId_idx" ON "world_items"("worldId");

-- CreateIndex
CREATE INDEX "world_items_sourceId_idx" ON "world_items"("sourceId");

-- CreateIndex
CREATE UNIQUE INDEX "world_items_worldId_key_key" ON "world_items"("worldId", "key");

-- CreateIndex
CREATE INDEX "world_checkpoints_worldId_idx" ON "world_checkpoints"("worldId");

-- CreateIndex
CREATE INDEX "world_checkpoints_messageId_idx" ON "world_checkpoints"("messageId");

-- CreateIndex
CREATE INDEX "memories_userId_kind_idx" ON "memories"("userId", "kind");

-- CreateIndex
CREATE INDEX "memories_userId_status_idx" ON "memories"("userId", "status");

-- CreateIndex
CREATE INDEX "memories_worldId_idx" ON "memories"("worldId");

-- AddForeignKey
ALTER TABLE "world_items" ADD CONSTRAINT "world_items_worldId_fkey" FOREIGN KEY ("worldId") REFERENCES "worlds"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "world_checkpoints" ADD CONSTRAINT "world_checkpoints_worldId_fkey" FOREIGN KEY ("worldId") REFERENCES "worlds"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "memories" ADD CONSTRAINT "memories_worldId_fkey" FOREIGN KEY ("worldId") REFERENCES "worlds"("id") ON DELETE SET NULL ON UPDATE CASCADE;

