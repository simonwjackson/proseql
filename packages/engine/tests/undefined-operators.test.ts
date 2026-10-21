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

it("does not match explicit undefined with string operators", async () => {
 const db = await createEngineDatabase({rows:{schema:Schema.Struct({id:Schema.String,name:Schema.optional(Schema.String)}),relationships:{}}}, {rows:[{id:"missing",name:undefined},{id:"present",name:"a"}]});
 try {
  for (const operator of ["$startsWith", "$endsWith", "$contains", "$search"]) {
   expect((await db.rows.query({where:{name:{[operator]:"a"}}})).map(row=>row.id)).toEqual(["present"]);
  }
 } finally { await db.close(); }
});

it("includes newly inserted upsert rows after a query has been cached", async () => {
 const db = await createEngineDatabase({rows:{schema:Schema.Struct({id:Schema.String,name:Schema.String}),relationships:{}}},{rows:[{id:"a",name:"A"}]});
 try { await db.rows.query(); await db.rows.upsert({where:{id:"b"},create:{id:"b",name:"B"},update:{name:"B"}}); expect((await db.rows.query()).map(row=>row.id)).toEqual(["a","b"]); } finally { await db.close(); }
});

it("rejects function removal before single, bulk or transaction mutation", async () => {
 const db = await createEngineDatabase({rows:{schema:Schema.Struct({id:Schema.String,tags:Schema.Array(Schema.String)}),relationships:{}}},{rows:[{id:"a",tags:["same","same","keep"]},{id:"b",tags:["keep"]}]});
 let called = false;
 const data = {tags:{$remove:()=>{called=true;throw new Error("must not run");}}} as never;
 try {
  await expect(db.rows.update("a",data)).rejects.toMatchObject({_tag:"ValidationError"});
  await expect(db.rows.updateMany({},data)).rejects.toMatchObject({_tag:"ValidationError"});
  await expect(db.$transaction(async (tx) => { await tx.rows.update("a",data); })).rejects.toMatchObject({_tag:"ValidationError"});
  expect(called).toBe(false);
  expect((await db.rows.findById("a"))?.tags).toEqual(["same","same","keep"]);
  expect((await db.rows.findById("b"))?.tags).toEqual(["keep"]);
 } finally { await db.close(); }
});
