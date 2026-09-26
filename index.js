const dns = require("dns");
dns.setServers(["8.8.8.8", "8.8.4.4", "1.1.1.1"]);

const express = require("express");
const cors = require("cors");
const { MongoClient, ObjectId } = require("mongodb");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const multer = require("multer");
const cloudinary = require("cloudinary").v2;
const sharp = require("sharp");
try {
  require("dotenv").config();
} catch (e) {}

const app = express();
const JWT_SECRET = process.env.JWT_SECRET || "adornica-secret-key-2026";
const MONGO_URI =
  process.env.MONGO_URI ||
  "mongodb://192.168.0.59:27017/softy-portfolio";

let cachedClient = null;
let cachedDb = null;

async function connectDB() {
  if (cachedDb) return cachedDb;
  const client = new MongoClient(MONGO_URI);
  await client.connect();
  cachedClient = client;
  cachedDb = client.db("softy-portfolio");
  await cachedDb.collection("admins").createIndex({ username: 1 }, { unique: true });
  await cachedDb.collection("products").createIndex({ order: 1 });
  await cachedDb.collection("brands").createIndex({ slug: 1 }, { unique: true });
  await cachedDb.collection("categories").createIndex({ slug: 1 }, { unique: true });
  return cachedDb;
}

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const allowed = /jpeg|jpg|png|gif|webp|svg/;
    const ext = allowed.test(require("path").extname(file.originalname).toLowerCase());
    const mime = allowed.test(file.mimetype);
    if (ext && mime) return cb(null, true);
    cb(new Error("Only image files are allowed"));
  },
});

const allowedOrigins = [
  "http://localhost:1003",
  "http://localhost:3000",
  "https://softyy-portfolio.vercel.app",
];
if (process.env.FRONTEND_URL) allowedOrigins.push(process.env.FRONTEND_URL);

app.use(
  cors({
    origin: (origin, cb) => {
      if (!origin || allowedOrigins.includes(origin)) cb(null, true);
      else cb(null, true);
    },
    credentials: true,
  }),
);
app.use(express.json({ limit: "10mb" }));

function authMiddleware(req, res, next) {
  const header = req.headers.authorization;
  if (!header || !header.startsWith("Bearer ")) {
    return res.status(401).json({ error: "No token provided" });
  }
  try {
    const decoded = jwt.verify(header.split(" ")[1], JWT_SECRET);
    req.adminId = decoded.id;
    next();
  } catch (err) {
    return res.status(401).json({ error: "Invalid token" });
  }
}

// ─── Auth ───────────────────────────────────────────────────────────────────

app.post("/api/auth/register", async (req, res) => {
  try {
    const db = await connectDB();
    const { username, password } = req.body;
    if (!username || !password)
      return res.status(400).json({ error: "Username and password required" });
    const existing = await db.collection("admins").findOne({ username });
    if (existing)
      return res.status(400).json({ error: "Username already exists" });
    const hashedPassword = await bcrypt.hash(password, 10);
    const result = await db
      .collection("admins")
      .insertOne({ username, password: hashedPassword, createdAt: new Date() });
    const token = jwt.sign(
      { id: result.insertedId.toString(), username },
      JWT_SECRET,
      { expiresIn: "7d" },
    );
    res.status(201).json({ token, admin: { id: result.insertedId, username } });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post("/api/auth/login", async (req, res) => {
  try {
    const db = await connectDB();
    const { username, password } = req.body;
    if (!username || !password)
      return res.status(400).json({ error: "Username and password required" });
    const admin = await db.collection("admins").findOne({ username });
    if (!admin) return res.status(401).json({ error: "Invalid credentials" });
    const valid = await bcrypt.compare(password, admin.password);
    if (!valid) return res.status(401).json({ error: "Invalid credentials" });
    const token = jwt.sign(
      { id: admin._id.toString(), username: admin.username },
      JWT_SECRET,
      { expiresIn: "7d" },
    );
    res.json({ token, admin: { id: admin._id, username: admin.username } });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get("/api/auth/me", authMiddleware, async (req, res) => {
  try {
    const db = await connectDB();
    const admin = await db
      .collection("admins")
      .findOne(
        { _id: new ObjectId(req.adminId) },
        { projection: { password: 0 } },
      );
    if (!admin) return res.status(404).json({ error: "Admin not found" });
    res.json({ admin });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── Content ────────────────────────────────────────────────────────────────

app.get("/api/content", async (req, res) => {
  try {
    const db = await connectDB();
    const content = await db
      .collection("siteSettings")
      .findOne({ type: "main" });
    res.json(content || getDefaultContent());
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get("/api/content/:section", async (req, res) => {
  try {
    const db = await connectDB();
    const content = await db
      .collection("siteSettings")
      .findOne({ type: "main" });
    const data = content || getDefaultContent();
    if (!data[req.params.section])
      return res.status(404).json({ error: "Section not found" });
    res.json(data[req.params.section]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.put("/api/content", authMiddleware, async (req, res) => {
  try {
    const db = await connectDB();
    const existing = await db
      .collection("siteSettings")
      .findOne({ type: "main" });
    const updated = {
      ...getDefaultContent(),
      ...(existing || {}),
      ...req.body,
      type: "main",
    };
    if (existing) {
      await db
        .collection("siteSettings")
        .updateOne({ type: "main" }, { $set: updated });
    } else {
      await db.collection("siteSettings").insertOne(updated);
    }
    res.json(updated);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── Upload ─────────────────────────────────────────────────────────────────

const optimizeCloudinaryImage = async (file) => {
  const levels = [[1000, 76], [900, 66], [800, 60], [700, 55], [600, 50], [480, 45]];
  let output;
  for (const [size, quality] of levels) {
    output = await sharp(file.buffer, { animated: false }).rotate()
      .resize({ width: size, height: size, fit: "inside", withoutEnlargement: true })
      .webp({ quality, effort: 6, smartSubsample: true }).toBuffer();
    if (output.length <= 100 * 1024) return output;
  }
  return output;
};

app.post("/api/upload", authMiddleware, upload.single("image"), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: "No file uploaded" });
    const db = await connectDB();
    const content = await db.collection("siteSettings").findOne({ type: "main" }) || getDefaultContent();
    const integration = content.integrations?.cloudinary || {};
    const cloudName = integration.cloudName || process.env.CLOUDINARY_CLOUD_NAME;
    if (integration.enabled && cloudName && process.env.CLOUDINARY_API_KEY && process.env.CLOUDINARY_API_SECRET && cloudName !== "demo") {
      cloudinary.config({ cloud_name: cloudName, api_key: process.env.CLOUDINARY_API_KEY, api_secret: process.env.CLOUDINARY_API_SECRET });
      const optimizedBuffer = await optimizeCloudinaryImage(req.file);
      const options = { folder: integration.folder || "softy-portfolio", resource_type: "image", format: "webp" };
      if (integration.uploadPreset) options.upload_preset = integration.uploadPreset;
      const result = await new Promise((resolve, reject) => { const stream = cloudinary.uploader.upload_stream(options, (error, value) => error ? reject(error) : resolve(value)); stream.end(optimizedBuffer); });
      return res.json({ url: result.secure_url, publicId: result.public_id });
    }
    const base64 = `data:${req.file.mimetype};base64,${req.file.buffer.toString("base64")}`;
    res.json({ url: base64 });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── Products ───────────────────────────────────────────────────────────────

app.get("/api/products", async (req, res) => {
  try {
    const db = await connectDB();
    const filter = { isActive: { $ne: false } };
    if (req.query.brandId) filter.brandId = req.query.brandId;
    if (req.query.categoryId) filter.categoryId = req.query.categoryId;
    const products = await db
      .collection("products")
      .find(filter)
      .sort({ order: 1 })
      .toArray();
    res.json(products);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get("/api/products/:id", async (req, res) => {
  try {
    const db = await connectDB();
    const product = await db
      .collection("products")
      .findOne({ _id: new ObjectId(req.params.id) });
    if (!product) return res.status(404).json({ error: "Product not found" });
    res.json(product);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post("/api/products/:id/related", async (req, res) => {
  try {
    const db = await connectDB();
    const product = await db
      .collection("products")
      .findOne({ _id: new ObjectId(req.params.id) });
    if (!product) return res.status(404).json({ error: "Product not found" });
    const filter = { _id: { $ne: new ObjectId(req.params.id) } };
    if (product.brandId) filter.brandId = product.brandId;
    if (product.categoryId) filter.categoryId = product.categoryId;
    const related = await db
      .collection("products")
      .find(filter)
      .limit(4)
      .toArray();
    res.json(related);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post("/api/products", authMiddleware, async (req, res) => {
  try {
    const db = await connectDB();
    const product = { ...req.body, createdAt: new Date() };
    const result = await db.collection("products").insertOne(product);
    res.status(201).json({ ...product, _id: result.insertedId });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.put("/api/products/:id", authMiddleware, async (req, res) => {
  try {
    const db = await connectDB();
    const { _id, ...updateData } = req.body;
    await db
      .collection("products")
      .updateOne({ _id: new ObjectId(req.params.id) }, { $set: updateData });
    const product = await db
      .collection("products")
      .findOne({ _id: new ObjectId(req.params.id) });
    res.json(product);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.delete("/api/products/:id", authMiddleware, async (req, res) => {
  try {
    const db = await connectDB();
    await db
      .collection("products")
      .deleteOne({ _id: new ObjectId(req.params.id) });
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── Brands ─────────────────────────────────────────────────────────────────

app.get("/api/brands", async (req, res) => {
  try {
    const db = await connectDB();
    const activeProducts = await db.collection("products")
      .find({ isActive: { $ne: false } }, { projection: { brandId: 1 } })
      .toArray();
    const brandIds = [...new Set(activeProducts.map((product) => product.brandId).filter(ObjectId.isValid))]
      .map((id) => new ObjectId(id));
    const brands = await db
      .collection("brands")
      .find({ _id: { $in: brandIds } })
      .sort({ order: 1 })
      .toArray();
    res.json(brands);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get("/api/brands/:slug", async (req, res) => {
  try {
    const db = await connectDB();
    const brand = await db
      .collection("brands")
      .findOne({ slug: req.params.slug });
    if (!brand) return res.status(404).json({ error: "Brand not found" });
    res.json(brand);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post("/api/brands", authMiddleware, async (req, res) => {
  try {
    const db = await connectDB();
    const brand = { ...req.body, createdAt: new Date() };
    const result = await db.collection("brands").insertOne(brand);
    res.status(201).json({ ...brand, _id: result.insertedId });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.put("/api/brands/:id", authMiddleware, async (req, res) => {
  try {
    const db = await connectDB();
    const { _id, ...updateData } = req.body;
    await db
      .collection("brands")
      .updateOne({ _id: new ObjectId(req.params.id) }, { $set: updateData });
    const brand = await db
      .collection("brands")
      .findOne({ _id: new ObjectId(req.params.id) });
    res.json(brand);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.delete("/api/brands/:id", authMiddleware, async (req, res) => {
  try {
    const db = await connectDB();
    await db
      .collection("brands")
      .deleteOne({ _id: new ObjectId(req.params.id) });
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── Categories ─────────────────────────────────────────────────────────────

app.get("/api/categories", async (req, res) => {
  try {
    const db = await connectDB();
    const activeProducts = await db.collection("products")
      .find({ isActive: { $ne: false } }, { projection: { categoryId: 1 } })
      .toArray();
    const categoryIds = [...new Set(activeProducts.map((product) => product.categoryId).filter(ObjectId.isValid))]
      .map((id) => new ObjectId(id));
    const categories = await db
      .collection("categories")
      .find({ _id: { $in: categoryIds } })
      .sort({ order: 1 })
      .toArray();
    res.json(categories);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get("/api/categories/:slug", async (req, res) => {
  try {
    const db = await connectDB();
    const category = await db
      .collection("categories")
      .findOne({ slug: req.params.slug });
    if (!category) return res.status(404).json({ error: "Category not found" });
    res.json(category);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post("/api/categories", authMiddleware, async (req, res) => {
  try {
    const db = await connectDB();
    const category = { ...req.body, createdAt: new Date() };
    const result = await db.collection("categories").insertOne(category);
    res.status(201).json({ ...category, _id: result.insertedId });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.put("/api/categories/:id", authMiddleware, async (req, res) => {
  try {
    const db = await connectDB();
    const { _id, ...updateData } = req.body;
    await db
      .collection("categories")
      .updateOne({ _id: new ObjectId(req.params.id) }, { $set: updateData });
    const category = await db
      .collection("categories")
      .findOne({ _id: new ObjectId(req.params.id) });
    res.json(category);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.delete("/api/categories/:id", authMiddleware, async (req, res) => {
  try {
    const db = await connectDB();
    await db
      .collection("categories")
      .deleteOne({ _id: new ObjectId(req.params.id) });
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── Helpers ────────────────────────────────────────────────────────────────

function getDefaultContent() {
  return {
    type: "main",
    integrations: {
      googleAnalytics: { enabled: Boolean(process.env.GA_MEASUREMENT_ID || process.env.GOOGLE_ANALYTICS_ID), measurementId: process.env.GA_MEASUREMENT_ID || process.env.GOOGLE_ANALYTICS_ID || "" },
      facebookPixel: { enabled: Boolean(process.env.FACEBOOK_PIXEL_ID), pixelId: process.env.FACEBOOK_PIXEL_ID || "" },
      cloudinary: { enabled: true, cloudName: process.env.CLOUDINARY_CLOUD_NAME || "", uploadPreset: process.env.CLOUDINARY_UPLOAD_PRESET || "", folder: process.env.CLOUDINARY_FOLDER || "softy-portfolio" },
    },
    emailSettings: { enabled: true, forwardingEnabled: true, forwardingEmail: process.env.ORDER_FORWARDING_EMAIL || process.env.GMAIL_USER || "", senderName: process.env.EMAIL_SENDER_NAME || "Global Cosmetics Lines", replyTo: process.env.EMAIL_REPLY_TO || "" },
    hero: {
      eyebrow: "Global Cosmetics Lines - care made close to home",
      title: "Care that feels",
      titleItalic: "quietly certain.",
      description:
        "A cleaner, warmer storefront for everyday skincare - easy to scan, easy to trust, and designed around the way real customers browse.",
      primaryBtn: "Explore the collection",
      secondaryBtn: "Our Story",
      image: "/products/softyy/cover.jpg",
      floatingCard: {
        small: "Customer Focus",
        title: "Oil control, without the noise.",
        desc: "Simple guidance, clear product intent.",
        image: "/brand/softyy-logo.png",
      },
      stats: [
        { label: "Everyday-first formulas", sublabel: "" },
        { label: "Careful product curation", sublabel: "" },
        { label: "Support you can reach", sublabel: "" },
      ],
    },
    marquee: {
      items: [
        "Feel The Pure Softness",
        "Global Cosmetics Lines",
        "Softyy",
        "Fresh Daily Confidence",
        "Authentic Skincare",
        "Quality You Can Trust",
        "Lab-Guided Formulas",
      ],
    },
    manifesto: {
      eyebrow: "Our philosophy",
      title: "Healthy skin should feel simple, safe, and dependable.",
      description:
        "We combine accessible pricing, careful sourcing, and active formulation standards so daily self-care feels transparent from first click to final application.",
      quote:
        "Global Cosmetics Lines is built for customers who want beauty products they can trust on their skin and in their routine.",
      stats: [
        { number: "01", label: "Authentic sourcing" },
        { number: "02", label: "Lab-led quality" },
        { number: "03", label: "All skin types" },
        { number: "04", label: "Fast support" },
      ],
    },
    story: {
      eyebrow: "The brand story",
      title: "Global Cosmetics Lines, built around trust.",
      description:
        "Global Cosmetics Lines makes authentic skincare, cosmetics, personal care, and freshness essentials easier to discover, safer to buy, and more enjoyable to use across Bangladesh.",
      items: [
        {
          icon: "shield",
          title: "Safety comes first",
          desc: "A strict zero-tolerance approach to counterfeit products protects every customer order.",
        },
        {
          icon: "flask",
          title: "Formulated with care",
          desc: "Experienced chemists and an active R&D team guide quality control and product development.",
        },
        {
          icon: "heart",
          title: "Trust in every step",
          desc: "From product details to delivery support, Global Cosmetics Lines is designed to feel clear and dependable.",
        },
      ],
      ctaBtn: "Partner with GCL",
    },
    testimonial: {
      stars: 5,
      quote:
        "A beauty and skincare brand portfolio grounded in authenticity, accessible luxury, and customer confidence.",
      person: "GLOBAL COSMETICS LINES",
      role: "Brand Portfolio Statement",
    },
    cta: {
      eyebrow: "Business & partnerships",
      title: "Let's build a more trusted beauty routine.",
      description:
        "For distribution, retail, collaborations, press, and business partnerships, connect with the Global Cosmetics Lines team.",
      email: "globalcosmeticslines@gmail.com",
    },
    footer: {
      description:
        "The beauty house behind Softyy skincare and Fresh Daily essentials. Feel The Pure Softness.",
      columns: [
        {
          title: "Discover",
          links: [
            { text: "Collection", href: "/collection" },
            { text: "Brand Story", href: "/story" },
            { text: "Philosophy", href: "/philosophy" },
          ],
        },
        {
          title: "Business",
          links: [
            { text: "Distribution", href: "/contact" },
            { text: "Retail", href: "/contact" },
            { text: "Support", href: "/contact" },
          ],
        },
        {
          title: "Social",
          links: [
            { text: "Facebook", href: "https://www.facebook.com/softyybd" },
            { text: "WhatsApp", href: "https://wa.me/8801911238421" },
            { text: "Email", href: "mailto:globalcosmeticslines@gmail.com" },
          ],
        },
      ],
      copyright: "2026 Global Cosmetics Lines. All rights reserved.",
      tagline: "Feel The Pure Softness.",
    },
    navbar: {
      brandName: "Global Cosmetics Lines",
      brandInitial: "G",
      logo: "/brand/gcl-main-logo.png",
      links: [
        { text: "Collection", href: "/collection" },
        { text: "Our brands", href: "/brands" },
        { text: "Philosophy", href: "/philosophy" },
        { text: "Our Story", href: "/story" },
      ],
      ctaBtn: "Explore Beauty",
    },
  };
}

async function seedData(db) {
  try {
    const existingAdmin = await db
      .collection("admins")
      .findOne({ username: "admin" });
    const hashedPassword = await bcrypt.hash("admin123", 10);
    if (!existingAdmin) {
      await db
        .collection("admins")
        .insertOne({
          username: "admin",
          password: hashedPassword,
          createdAt: new Date(),
        });
    } else {
      const defaultPasswordWorks = await bcrypt.compare("admin123", existingAdmin.password || "");
      if (!defaultPasswordWorks) {
        await db.collection("admins").updateOne(
          { username: "admin" },
          { $set: { password: hashedPassword, updatedAt: new Date() } },
        );
      }
    }
    const existingContent = await db
      .collection("siteSettings")
      .findOne({ type: "main" });
    if (!existingContent) {
      await db.collection("siteSettings").insertOne(getDefaultContent());
    } else if (!existingContent.integrations || !existingContent.emailSettings) {
      await db.collection("siteSettings").updateOne({ type: "main" }, { $set: { integrations: existingContent.integrations || getDefaultContent().integrations, emailSettings: existingContent.emailSettings || getDefaultContent().emailSettings } });
    }

    const existingBrands = await db.collection("brands").countDocuments();
    if (existingBrands === 0) {
      await db.collection("brands").insertMany([
        {
          name: "Softyy",
          slug: "softyy",
          logo: "/brand/softyy-logo.png",
          description: "Authentic skincare and cosmetics for healthy everyday confidence. Feel The Pure Softness.",
          order: 0,
          createdAt: new Date(),
        },
        {
          name: "Fresh Daily",
          slug: "fd-fresh-daily",
          logo: "/brand/softyy-mark-set.png",
          description: "Fresh daily personal care and home essentials for simple, reliable routines.",
          order: 1,
          createdAt: new Date(),
        },
      ]);
    }

    const existingCategories = await db
      .collection("categories")
      .countDocuments();
    if (existingCategories === 0) {
      await db.collection("categories").insertMany([
        {
          name: "Face Wash",
          slug: "face-wash",
          image: "/products/softyy/lemon-face-wash.jpg",
          description: "Gentle cleansing face washes for all skin types.",
          order: 0,
          createdAt: new Date(),
        },
        {
          name: "Serums",
          slug: "serums",
          image: "/products/softyy/acne-serum.jpg",
          description: "Targeted treatment serums for specific skin concerns.",
          order: 1,
          createdAt: new Date(),
        },
        {
          name: "Soothing Gels",
          slug: "soothing-gels",
          image: "/products/softyy/milk-soothing-gel.jpg",
          description: "Calming and moisturizing gels for skin recovery.",
          order: 2,
          createdAt: new Date(),
        },
        {
          name: "Soaps",
          slug: "soaps",
          image: "/products/fresh-daily/acne-control-soap.jpg",
          description: "Effective cleansing bars for face and body.",
          order: 3,
          createdAt: new Date(),
        },
        {
          name: "Air Fresheners",
          slug: "air-fresheners",
          image: "/products/fresh-daily/jasmine-air-freshener.jpg",
          description: "Long-lasting fragrances for home and office.",
          order: 4,
          createdAt: new Date(),
        },
      ]);
    }

    const existingProducts = await db.collection("products").countDocuments();
    if (existingProducts === 0) {
      const brands = await db.collection("brands").find().toArray();
      const categories = await db.collection("categories").find().toArray();
      const brandMap = {};
      brands.forEach((b) => { brandMap[b.name] = b._id.toString(); });
      const categoryMap = {};
      categories.forEach((c) => { categoryMap[c.name] = c._id.toString(); });

      await db.collection("products").insertMany([
        {
          title: "Softyy Lemon Face Wash",
          slug: "softyy-lemon-face-wash",
          desc: "Oil Control · Acne Control · Brightening Deep Cleansing",
          tag: "Face Wash",
          image: "/products/softyy/lemon-face-wash.jpg",
          images: ["/products/softyy/lemon-face-wash.jpg"],
          size: "large",
          order: 0,
          price: 350,
          brandId: brandMap["Softyy"],
          categoryId: categoryMap["Face Wash"],
          features: ["Oil Control", "Acne Control", "Brightening Deep Cleansing", "Paraben & Sulphate Free", "For All Skin Types"],
          details: "Softyy Lemon Face Wash deeply cleanses with natural lemon power, controls oil, and brings natural glow. 100ml.",
          inStock: true,
          isNew: false,
          createdAt: new Date(),
        },
        {
          title: "Softyy Milk Expert Face Wash",
          slug: "softyy-milk-expert-face-wash",
          desc: "Brightening · Extra Moisturizing · Gentle Cleansing",
          tag: "Face Wash",
          image: "/products/softyy/milk-face-wash.jpg",
          images: ["/products/softyy/milk-face-wash.jpg"],
          size: "side",
          order: 1,
          price: 350,
          brandId: brandMap["Softyy"],
          categoryId: categoryMap["Face Wash"],
          features: ["Brightening", "Extra Moisturizing", "Gentle Cleansing", "Paraben & Sulphate Free", "For All Skin Types"],
          details: "Softyy Milk Expert Face Wash is a premium daily care formula that cleanses gently without drying. 100ml.",
          inStock: true,
          isNew: false,
          createdAt: new Date(),
        },
        {
          title: "Softyy Acne Control Serum",
          slug: "softyy-acne-control-serum",
          desc: "2% Salicylic Acid · 5% Niacinamide · 30ml",
          tag: "Serum",
          image: "/products/softyy/acne-serum.jpg",
          images: ["/products/softyy/acne-serum.jpg"],
          size: "third",
          order: 2,
          price: 450,
          brandId: brandMap["Softyy"],
          categoryId: categoryMap["Serums"],
          features: ["2% Salicylic Acid", "5% Niacinamide", "Acne & Dark Spot Treatment", "All Skin Types", "30ml"],
          details: "Softyy Acne Control Face Serum for spotless, bright, and radiant skin. Targets acne and stubborn dark spots.",
          inStock: true,
          isNew: true,
          createdAt: new Date(),
        },
        {
          title: "Softyy Papaya Face Wash",
          slug: "softyy-papaya-face-wash",
          desc: "Glow Boost · Anti-Blemish · Gentle Deep Clean",
          tag: "Face Wash",
          image: "/products/softyy/papaya-face-wash.jpg",
          images: ["/products/softyy/papaya-face-wash.jpg"],
          size: "third",
          order: 3,
          price: 350,
          brandId: brandMap["Softyy"],
          categoryId: categoryMap["Face Wash"],
          features: ["Glow Boost", "Anti-Blemish", "Gentle Deep Clean", "Paraben & Sulphate Free", "For All Skin Types"],
          details: "Softyy Papaya Face Wash with natural papaya power for bright, clean, and glowing skin. 100ml.",
          inStock: true,
          isNew: false,
          createdAt: new Date(),
        },
        {
          title: "Softyy Salicylic Acid Face Wash",
          slug: "softyy-salicylic-acid-face-wash",
          desc: "Acne Control · Deep Pore Cleansing · Blackheads",
          tag: "Face Wash",
          image: "/products/softyy/salicylic-face-wash.jpg",
          images: ["/products/softyy/salicylic-face-wash.jpg"],
          size: "third",
          order: 4,
          price: 350,
          brandId: brandMap["Softyy"],
          categoryId: categoryMap["Face Wash"],
          features: ["Acne Control", "Deep Pore Cleansing", "Blackheads & Whiteheads", "Paraben & Sulphate Free", "For All Skin Types"],
          details: "Softyy Salicylic Acid Face Wash for acne-free fresh skin. Deep cleanses and removes stubborn acne marks.",
          inStock: true,
          isNew: false,
          createdAt: new Date(),
        },
        {
          title: "Softyy Milk Soothing Gel",
          slug: "softyy-milk-soothing-gel",
          desc: "Deep Moisturizing · Sunburn Recovery · 250gm",
          tag: "Gel",
          image: "/products/softyy/milk-soothing-gel.jpg",
          images: ["/products/softyy/milk-soothing-gel.jpg"],
          size: "side",
          order: 5,
          price: 480,
          brandId: brandMap["Softyy"],
          categoryId: categoryMap["Soothing Gels"],
          features: ["99% Pure Formula", "Deep Moisturizing", "Sunburn Recovery", "For Sensitive Skin", "250gm"],
          details: "Softyy Milk Soothing Gel with 99% pure formula for deep moisturizing and sunburn recovery. 250gm jar.",
          inStock: true,
          isNew: false,
          createdAt: new Date(),
        },
        {
          title: "Fresh Daily Acne Control Soap",
          slug: "fresh-daily-acne-control-soap",
          desc: "Oil Control · Prevents Acne · Unclogs Pores",
          tag: "Soap",
          image: "/products/fresh-daily/acne-control-soap.jpg",
          images: ["/products/fresh-daily/acne-control-soap.jpg"],
          size: "third",
          order: 6,
          price: 120,
          brandId: brandMap["Fresh Daily"],
          categoryId: categoryMap["Soaps"],
          features: ["Oil Control", "Prevents Acne", "Unclogs Pores", "Reduces Redness", "Face & Body", "80gm"],
          details: "Fresh Daily Acne Control Soap for daily freshness and spotless skin. Anti-acne & oil balancing bar.",
          inStock: true,
          isNew: false,
          createdAt: new Date(),
        },
        {
          title: "Fresh Daily Kojic Acid Soap",
          slug: "fresh-daily-kojic-acid-soap",
          desc: "Double Brightening · Face & Body · 80gm",
          tag: "Soap",
          image: "/products/fresh-daily/kojic-acid-soap.jpg",
          images: ["/products/fresh-daily/kojic-acid-soap.jpg"],
          size: "third",
          order: 7,
          price: 150,
          brandId: brandMap["Fresh Daily"],
          categoryId: categoryMap["Soaps"],
          features: ["Brightens Skin Tone", "Deeply Moisturizes", "Helps Prevent Acne", "Reduces Signs of Aging", "80gm"],
          details: "Fresh Daily Kojic Acid Soap - The Brightening Ritual. Double brightening facial bar for face and body.",
          inStock: true,
          isNew: true,
          createdAt: new Date(),
        },
        {
          title: "Fresh Daily Jasmine Bliss Air Freshener",
          slug: "fresh-daily-jasmine-bliss",
          desc: "Natural Jasmine Fragrance · Long Lasting · 300ml",
          tag: "Air Freshener",
          image: "/products/fresh-daily/jasmine-air-freshener.jpg",
          images: ["/products/fresh-daily/jasmine-air-freshener.jpg"],
          size: "third",
          order: 8,
          price: 250,
          brandId: brandMap["Fresh Daily"],
          categoryId: categoryMap["Air Fresheners"],
          features: ["Natural Jasmine Scent", "Long Lasting", "Quick Odor Elimination", "Home & Office", "300ml"],
          details: "Fresh Daily Jasmine Bliss Air Freshener with the enchanting scent of jasmine flowers.",
          inStock: true,
          isNew: false,
          createdAt: new Date(),
        },
        {
          title: "Fresh Daily Lavender Touch Air Freshener",
          slug: "fresh-daily-lavender-touch",
          desc: "Relaxing Lavender · Mood Refreshing · 300ml",
          tag: "Air Freshener",
          image: "/products/fresh-daily/lavender-air-freshener.jpg",
          images: ["/products/fresh-daily/lavender-air-freshener.jpg"],
          size: "third",
          order: 9,
          price: 250,
          brandId: brandMap["Fresh Daily"],
          categoryId: categoryMap["Air Fresheners"],
          features: ["Relaxing Lavender Scent", "Mood Refreshing", "Long Lasting", "Home & Office", "300ml"],
          details: "Fresh Daily Lavender Touch Air Freshener for a romantic, refreshing atmosphere.",
          inStock: true,
          isNew: false,
          createdAt: new Date(),
        },
        {
          title: "Fresh Daily Lemon Zest Air Freshener",
          slug: "fresh-daily-lemon-zest",
          desc: "Citrus Fresh · Energizing · 300ml",
          tag: "Air Freshener",
          image: "/products/fresh-daily/lemon-air-freshener.jpg",
          images: ["/products/fresh-daily/lemon-air-freshener.jpg"],
          size: "third",
          order: 10,
          price: 250,
          brandId: brandMap["Fresh Daily"],
          categoryId: categoryMap["Air Fresheners"],
          features: ["Citrus Fresh Scent", "Energizing", "Long Lasting", "Quick Odor Elimination", "300ml"],
          details: "Fresh Daily Lemon Zest Air Freshener with citrus freshness for an energetic environment.",
          inStock: true,
          isNew: false,
          createdAt: new Date(),
        },
        {
          title: "Fresh Daily Bakhoor Anti Tobacco",
          slug: "fresh-daily-bakhoor-anti-tobacco",
          desc: "Premium Bakhoor · Anti-Tobacco Formula · 300ml",
          tag: "Air Freshener",
          image: "/products/fresh-daily/bakhoor-air-freshener.jpg",
          images: ["/products/fresh-daily/bakhoor-air-freshener.jpg"],
          size: "third",
          order: 11,
          price: 300,
          brandId: brandMap["Fresh Daily"],
          categoryId: categoryMap["Air Fresheners"],
          features: ["Premium Bakhoor Scent", "Anti-Tobacco Formula", "Royal Fragrance", "Home & Office", "300ml"],
          details: "Fresh Daily Bakhoor With Anti Tobacco - premium royal fragrance that eliminates tobacco odor.",
          inStock: true,
          isNew: false,
          createdAt: new Date(),
        },
      ]);
    }
  } catch (err) {
    console.error("Seed error:", err);
  }
}

// ─── Local dev only ─────────────────────────────────────────────────────────

if (process.env.VERCEL !== "1") {
  const PORT = process.env.PORT || 1004;
  (async () => {
    try {
      const db = await connectDB();
      await seedData(db);
      app.listen(PORT, "0.0.0.0", () => {
        console.log("Server running on " + PORT);
      });
    } catch (err) {
      console.error("Failed to start server:", err);
      process.exit(1);
    }
  })();
}

module.exports = app;
