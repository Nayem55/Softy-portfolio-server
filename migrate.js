const { MongoClient, ObjectId } = require("mongodb");
require("dotenv").config({ path: "backend/.env" });

const sourceUri = process.env.PORTFOLIO_LEGACY_MONGO_URI || "mongodb+srv://adornica-portfolio:adornica-portfolio@adornica-portfolio.ldmoler.mongodb.net/?appName=Adornica-portfolio";
const targetUri = process.env.MONGO_URI;
const sourceDatabase = "adornica-portfolio";
const targetDatabase = "softy-portfolio";

async function inventory(db) {
  const counts = {};
  for (const { name } of await db.listCollections().toArray()) counts[name] = await db.collection(name).countDocuments();
  return counts;
}

async function main() {
  if (!targetUri) throw new Error("MONGO_URI is missing from backend/.env.");
  const sourceClient = new MongoClient(sourceUri, { serverSelectionTimeoutMS: 30000 });
  const targetClient = new MongoClient(targetUri, { serverSelectionTimeoutMS: 30000 });

  try {
    console.log("Checking source and empty target before migration...");
    await Promise.all([sourceClient.connect(), targetClient.connect()]);
    const source = sourceClient.db(sourceDatabase);
    const target = targetClient.db(targetDatabase);
    const targetBefore = await inventory(target);
    if (Object.values(targetBefore).some((count) => count > 0)) throw new Error(`Target is not empty; no data changed: ${JSON.stringify(targetBefore)}`);

    const products = await source.collection("products").find({ isActive: true }).toArray();
    // Product relationships are strings; collection IDs are ObjectIds.
    const brandIds = [...new Set(products.map((product) => product.brandId).filter(ObjectId.isValid))].map((id) => new ObjectId(id));
    const categoryIds = [...new Set(products.map((product) => product.categoryId).filter(ObjectId.isValid))].map((id) => new ObjectId(id));
    const [brands, categories, admins, siteSettings] = await Promise.all([
      source.collection("brands").find({ _id: { $in: brandIds } }).toArray(),
      source.collection("categories").find({ _id: { $in: categoryIds } }).toArray(),
      source.collection("admins").find({}).toArray(),
      source.collection("siteSettings").find({ type: "main" }).toArray(),
    ]);

    const expected = { products: 26, brands: 2, categories: 9, admins: 1, siteSettings: 1 };
    const sourceCounts = { products: products.length, brands: brands.length, categories: categories.length, admins: admins.length, siteSettings: siteSettings.length };
    if (JSON.stringify(sourceCounts) !== JSON.stringify(expected)) throw new Error(`Unexpected source inventory: ${JSON.stringify(sourceCounts)}`);

    for (const [name, documents] of Object.entries({ products, brands, categories, admins, siteSettings })) await target.collection(name).insertMany(documents);
    await Promise.all([
      target.collection("admins").createIndex({ username: 1 }, { unique: true }),
      target.collection("products").createIndex({ order: 1 }),
      target.collection("brands").createIndex({ slug: 1 }, { unique: true }),
      target.collection("categories").createIndex({ slug: 1 }, { unique: true }),
    ]);

    const after = await inventory(target);
    const verified = Object.fromEntries(Object.keys(expected).map((name) => [name, after[name] || 0]));
    if (JSON.stringify(verified) !== JSON.stringify(expected)) throw new Error(`Target verification failed: ${JSON.stringify(verified)}`);
    console.log(`Migration verified: ${JSON.stringify(verified)}`);
  } finally {
    await Promise.allSettled([sourceClient.close(), targetClient.close()]);
  }
}

main().catch((error) => {
  console.error(`Migration aborted: ${error.message}`);
  process.exitCode = 1;
});
