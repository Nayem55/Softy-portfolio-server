require('dotenv').config({ path: require('node:path').resolve(__dirname, '..', '.env') });

const fs = require('node:fs');
const path = require('node:path');
const { MongoClient } = require('mongodb');
const { products, categoryDescriptions } = require('../../../Assets/catalog');

const MONGO_URI = process.env.MONGO_URI || 'mongodb://192.168.0.59:27017/softy-portfolio';
const imagePattern = /\.(?:jpe?g|png|webp)$/i;
const slugify = (value) => value.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
const brandPath = (brand) => brand === 'Softy' ? 'softyy' : 'fresh-daily';
const frontendRoot = path.resolve(__dirname, '..', '..', 'frontend', 'public');

function imagesFor(item) {
  const files = fs.readdirSync(item.folder, { withFileTypes: true })
    .filter((entry) => entry.isFile() && imagePattern.test(entry.name))
    .map((entry) => entry.name)
    .sort((left, right) => left.localeCompare(right, undefined, { numeric: true }));
  if (!files.length) throw new Error(`No product images found for ${item.name}`);
  const folder = path.join('products', brandPath(item.brand), item.slug);
  return files.map((file, index) => {
    const filename = `image-${index + 1}${path.extname(file).toLowerCase()}`;
    const destination = path.join(frontendRoot, folder, filename);
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    fs.copyFileSync(path.join(item.folder, file), destination);
    return `/${folder.replaceAll(path.sep, '/')}/${filename}`;
  });
}

function suppliedText(item) {
  const file = fs.readdirSync(item.folder, { withFileTypes: true }).find((entry) => entry.isFile() && entry.name.toLowerCase().endsWith('.txt'));
  return file ? fs.readFileSync(path.join(item.folder, file.name), 'utf8').trim() : '';
}

function priceFrom(text, name) {
  const price = text.match(/price\s*[-:]?\s*(\d+)/i);
  if (!price) throw new Error(`No price found in product text for ${name}`);
  return Number(price[1]);
}

async function syncCatalog() {
  const client = new MongoClient(MONGO_URI, { serverSelectionTimeoutMS: 12000 });
  await client.connect();
  const db = client.db('softy-portfolio');
  const now = new Date();

  try {
    const copied = new Map(products.map((item) => [item.slug, imagesFor(item)]));
    const categoryNames = [...new Set(products.map((item) => item.category))];
    const categoryMap = new Map();

    for (const [index, name] of categoryNames.entries()) {
      const item = products.find((product) => product.category === name);
      const slug = slugify(name);
      const result = await db.collection('categories').findOneAndUpdate(
        { slug },
        { $set: { name, slug, image: copied.get(item.slug)[0], description: categoryDescriptions[name], order: index, updatedAt: now }, $setOnInsert: { createdAt: now } },
        { upsert: true, returnDocument: 'after' },
      );
      categoryMap.set(name, result._id.toString());
    }

    const brandMap = new Map();
    for (const name of ['Softy', 'Fresh Daily']) {
      const slug = slugify(name);
      const legacy = name === 'Softy' ? await db.collection('brands').findOne({ slug: 'softyy' }) : null;
      const existing = await db.collection('brands').findOne({ slug });
      const result = await db.collection('brands').findOneAndUpdate(
        { slug },
        { $set: { name, slug, logo: name === 'Softy' ? '/brand/softy-ecom-logo-v2.png' : '/brand/fresh-daily-logo.png', description: name === 'Softy' ? 'Authentic skincare and cosmetics for healthy everyday confidence.' : 'Fresh personal care and home fragrance for everyday rituals.', updatedAt: now }, $setOnInsert: { order: name === 'Softy' ? 0 : 1, createdAt: now } },
        { upsert: true, returnDocument: 'after' },
      );
      brandMap.set(name, result._id.toString());
      if (legacy && legacy._id.toString() !== result._id.toString()) await db.collection('brands').deleteOne({ _id: legacy._id });
    }

    for (const [index, item] of products.entries()) {
      const text = suppliedText(item);
      const images = copied.get(item.slug);
      let existing = await db.collection('products').findOne({ $or: [{ slug: item.slug }, { slug: { $in: item.legacySlugs || [] } }, { title: item.name }] });
      if (existing?._id === null) {
        await db.collection('products').deleteOne({ _id: null });
        existing = null;
      }
      const payload = {
        title: item.name,
        slug: existing?.slug || item.slug,
        desc: item.features.slice(0, 3).join(' · '),
        tag: item.category,
        image: images[0],
        images,
        size: index === 0 ? 'large' : index === 1 ? 'side' : 'third',
        order: index,
        price: priceFrom(text, item.name),
        brandId: brandMap.get(item.brand),
        categoryId: categoryMap.get(item.category),
        features: item.features,
        details: text,
        volume: item.volume,
        inStock: true,
        isActive: true,
        isNew: Boolean(item.isNew),
        sourceCategory: item.category,
        updatedAt: now,
      };
      await db.collection('products').updateOne(existing ? { _id: existing._id } : { slug: item.slug }, { $set: payload, $setOnInsert: { createdAt: now } }, { upsert: true });
    }
    await db.collection('products').updateMany(
      { brandId: { $nin: [...brandMap.values()] }, isActive: { $ne: true } },
      { $set: { isActive: false, updatedAt: now } },
    );
    await db.collection('categories').deleteMany({ slug: { $in: ['serums', 'soothing-gels', 'soaps', 'air-fresheners'] } });
    console.log(`Synced ${products.length} portfolio products and ${categoryNames.length} categories.`);
  } finally {
    await client.close();
  }
}

syncCatalog().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
