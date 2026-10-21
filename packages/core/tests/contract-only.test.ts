import * as core from "../src/index.js";
import { expect, it } from "vitest";

it("exports shared contracts and codecs, never a database runtime", () => {
 for (const name of ["createEffectDatabase","createPersistentEffectDatabase","createCollectionState","filterData","applyFilter","watch","watchById","createTransaction","$transaction","buildIndexes","buildSearchIndex","dryRunMigrations","loadData","saveData"]) expect(core).not.toHaveProperty(name);
 for (const name of ["StorageAdapterService","SerializerRegistryService","normalizeSourceConfig","getCollectionConfigs","jsonCodec","makeSerializerLayer","ValidationError"]) expect(core).toHaveProperty(name);
});
