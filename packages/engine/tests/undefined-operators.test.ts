import { Schema } from "effect";
import { expect, it } from "vitest";
import { createEngineDatabase } from "../src/index.js";

it("does not match explicit undefined with array operators", async () => {
 const db = await createEngineDatabase({rows:{schema:Schema.Struct({id:Schema.String,tags:Schema.optional(Schema.Array(Schema.String))}),relationships:{}}}, {rows:[{id:"missing",tags:undefined},{id:"present",tags:["a"]}]});
 try {
  for (const where of [{tags:{$all:["a"]}},{tags:{$contains:"a"}},{tags:{$size:1}}]) {
   expect((await db.rows.query({where})).map(row=>row.id)).toEqual(["present"]);
  }
 } finally { await db.close(); }
});
