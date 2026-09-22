import type { Prisma } from '@aichat/db';

export const registrySelect = {
  id: true, modelKey: true, kind: true, providerId: true, capabilities: true,
} as const;

export function registryCapabilities(value: Prisma.JsonValue): Prisma.JsonObject {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

export function registryModel(model: {
  id: string; modelKey: string; kind: string; providerId: string; capabilities: Prisma.JsonValue;
}) {
  const capabilities = registryCapabilities(model.capabilities);
  return {
    id: model.id, modelKey: model.modelKey, kind: model.kind, provider: model.providerId,
    label: typeof capabilities.label === 'string' ? capabilities.label : model.modelKey,
    available: capabilities.available !== false,
  };
}
