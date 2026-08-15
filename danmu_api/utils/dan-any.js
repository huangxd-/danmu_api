import { UniDB } from '@dan-uni/dan-any/core/main/pure';
import {
  ArtplayerMetadata,
  ArtplayerTransformer,
  BahaMetadata,
  BahaTransformer,
  BiliXmlMetadata,
  BiliXmlTransformerConfigurator,
  DanuniJsonMetadata,
  DanuniJsonTransformerConfigurator,
  DanuniPbMetadata,
  DanuniPbTransformer,
  DdplayAdapter,
  DdplayMetadata,
  DdplayTransformer,
  DplayerMetadata,
  DplayerTransformer,
  VodMetadata,
  VodTransformer
} from '@dan-uni/dan-any/adapters';

export const danAnyFormats = [
  ArtplayerMetadata.type,
  BahaMetadata.type,
  BiliXmlMetadata.type,
  DanuniJsonMetadata.type,
  DanuniPbMetadata.type,
  DdplayMetadata.type,
  DplayerMetadata.type,
  VodMetadata.type
];

const danAnyDb = new UniDB();
const danAnyUdb = danAnyDb.init();

export function convertDanAny(danmuData, format) {
  const chunk = danAnyUdb.makeChunk({ tmp: true });
  chunk.import(DdplayAdapter(danmuData));

  if (format === VodMetadata.type) return { type: 'json', data: chunk.export(VodTransformer) };
  if (format === BahaMetadata.type) return { type: 'json', data: chunk.export(BahaTransformer) };
  if (format === DdplayMetadata.type) return { type: 'json', data: chunk.export(DdplayTransformer) };
  if (format === BiliXmlMetadata.type) return { type: 'xml', data: chunk.export(BiliXmlTransformerConfigurator()) };
  if (format === DplayerMetadata.type) return { type: 'json', data: chunk.export(DplayerTransformer) };
  if (format === DanuniPbMetadata.type) return { type: 'binary', data: chunk.export(DanuniPbTransformer), filename: 'danuni.binpb' };
  if (format === ArtplayerMetadata.type) return { type: 'json', data: chunk.export(ArtplayerTransformer) };
  if (format === DanuniJsonMetadata.type) return { type: 'json', data: chunk.export(DanuniJsonTransformerConfigurator()) };

  return null;
}
