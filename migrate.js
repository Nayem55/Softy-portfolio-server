const { MongoClient } = require('mongodb');
const dns = require('dns');

// Force Google DNS for SRV resolution
dns.setServers(['8.8.8.8', '8.8.4.4', '1.1.1.1']);

const LOCAL_URI = 'mongodb://192.168.0.59:27017/softy';
const REMOTE_URI = process.env.MONGO_URI || 'mongodb://192.168.0.59:27017/softy';

async function migrate() {
  const localClient = new MongoClient(LOCAL_URI);
  const remoteClient = new MongoClient(REMOTE_URI, { 
    serverSelectionTimeoutMS: 30000,
    connectTimeoutMS: 30000 
  });

  try {
    console.log('Connecting to local MongoDB...');
    await localClient.connect();
    const localDb = localClient.db();
    console.log('Connected to local DB');

    console.log('Connecting to remote MongoDB Atlas...');
    await remoteClient.connect();
    const remoteDb = remoteClient.db();
    console.log('Connected to remote DB');

    const collections = await localDb.listCollections().toArray();
    console.log('Found ' + collections.length + ' collections: ' + collections.map(c => c.name).join(', '));

    for (const col of collections) {
      const name = col.name;
      console.log('\nMigrating collection: ' + name);

      const docs = await localDb.collection(name).find().toArray();
      console.log('  Found ' + docs.length + ' documents');

      if (docs.length === 0) {
        console.log('  Skipping (empty)');
        continue;
      }

      await remoteDb.collection(name).deleteMany({});
      console.log('  Cleared remote collection');

      await remoteDb.collection(name).insertMany(docs);
      console.log('  Inserted ' + docs.length + ' documents');

      const indexes = await localDb.collection(name).indexes();
      for (const idx of indexes) {
        if (idx.name === '_id_') continue;
        try {
          const idxKeys = {};
          for (const [k, v] of Object.entries(idx.key)) {
            idxKeys[k] = v;
          }
          await remoteDb.collection(name).createIndex(idxKeys, {
            unique: idx.unique || false,
            name: idx.name
          });
          console.log('  Recreated index: ' + idx.name);
        } catch (e) {
          console.log('  Warning: Could not create index ' + idx.name + ': ' + e.message);
        }
      }
    }

    console.log('\nMigration complete!');
  } catch (err) {
    console.error('Migration failed:', err.message);
    if (err.cause) console.error('Cause:', err.cause.message || err.cause);
  } finally {
    await localClient.close();
    await remoteClient.close();
  }
}

migrate();
