# Plugin Federation Network (PFN) - ⚠️ BETA - USE WITH CAUTION ⚠️

A decentralized plugin distribution network that connects independent plugin publishers into a federated ecosystem.

![Plugin Federation Demo Image](./docs/assets/fedplugins.jpg)

```mermaid
graph LR
    classDef federation fill:#8b5cf6,color:white,stroke:#333,stroke-width:2px
    classDef publisher fill:#a2ff00,color:#black,stroke:#333,stroke-width:2px
    classDef consumer fill:#0ea5e9,color:white,stroke:#333,stroke-width:2px
    classDef marketplace fill:#f59e0b,color:#191919,stroke:#333,stroke-width:2px
    classDef standalone fill:#a2ff00,color:#191919,stroke:#333,stroke-width:2px

    subgraph Federation["Plugin Federation Network"]
        FN1[Federation Node 1]:::federation
        FN2[Federation Node 2]:::federation
        FN3[Federation Node 3]:::federation
        
        FN1 <--> FN2
        FN2 <--> FN3
        FN1 <--> FN3
    end

    subgraph Federated["Federated Plugin Publishers"]
        PP1[WordPress Publisher]:::publisher
        PP2[Custom Shop Publisher]:::publisher
        PP3[Theme Publisher]:::publisher
    end

    subgraph Standalone["Plugin Publisher Instances"]
        SP1[Independent Publisher 1]:::standalone
        SP2[Independent Publisher 2]:::standalone
        SP3[Independent Publisher 3]:::standalone

        subgraph SP1_Components["Publisher 1 Components"]
            SP1_R2[(R2 Storage)]
            SP1_DO[Registry DO]
            SP1_KV[(KV Store)]
            SP1_AUTH[Auth DO]
        end
    end

    subgraph Consumers["Plugin Consumers"]
        C1[WordPress Site]:::consumer
        C2[eCommerce Platform]:::consumer
        C3[Development Agency]:::consumer
        C4[Theme Marketplace]:::marketplace
		C5[WordPress Site]:::consumer
    end

    %% Standalone connections
    SP1 --> SP1_Components
    C1 --> SP1
    C2 --> SP2
    
    %% Federation connections
    PP1 -->|"Optional Federation"| FN1
    PP2 -->|"Optional Federation"| FN2
    PP3 -->|"Optional Federation"| FN3
    
    %% Federation consumer connections
    FN1 -->|"Subscribe"| C3
    FN2 -->|"Subscribe"| C4
    FN2 -->|"Subscribe"| C5
    
    %% Cross-node syncing
    PP1 -.->|"Mirror"| FN2
    PP2 -.->|"Mirror"| FN3
    PP3 -.->|"Mirror"| FN1

    %% Add explanatory notes
    note1[Solid lines = direct connections]
    note2[Dotted lines = federation syncing]
    note3[Publishers can operate standalone or join federation]
    note1 -.-> note2
    note2 -.-> note3
```

## Overview

The Plugin Federation Network (PFN) is a decentralized system that enables independent plugin publishers to form a network of trusted sources, share plugins, and maintain a distributed plugin ecosystem. Built on Cloudflare Workers and Durable Objects, PFN provides:

- Decentralized plugin distribution
- Source verification and trust scoring
- Plugin mirroring and caching
- Cryptographic verification of plugin authenticity
- Activity monitoring and version tracking
- Health monitoring and synchronization

## Prerequisites

Before setting up a federation node, ensure you have:

- A Cloudflare account with Workers and R2 enabled
- An existing Plugin Publisher instance ([See Plugin Publisher Federated Branch documentation](https://github.com/xpportal/Plugin-Publisher/tree/federated-option))
- [Wrangler CLI](https://developers.cloudflare.com/workers/wrangler/get-started/) installed
- Node.js 18 or later

## Quick Start

1. Create a new federation node:
   ```bash
   # Clone the repository
   git clone https://github.com/xpportal/plugin-federation-network
   cd plugin-federation

   # Install dependencies
   npm install

   # Deploy the worker
   npx wrangler deploy
   ```

2. Generate Ed25519 signing keys:
   ```bash
   node -e "
   const crypto = require('crypto');
   const { privateKey, publicKey } = crypto.generateKeyPairSync('ed25519');
   console.log('Private:', privateKey.export({type: 'pkcs8', format: 'pem'}));
   console.log('Public:', publicKey.export({type: 'spki', format: 'pem'}));
   "
   ```

3. Add the keys to your worker:
   ```bash
   wrangler secret put FEDERATION_PRIVATE_KEY
   wrangler secret put FEDERATION_PUBLIC_KEY
   ```

4. Set up initial admin access:
   ```bash
   # Generate a master admin key
   wrangler secret put MASTER_KEY
   
   # Use the master key to create additional admin keys via the API
   curl -X POST https://your-federation.workers.dev/federation/create-admin-key \
     -H "Authorization: Bearer YOUR_MASTER_KEY" \
     -H "Content-Type: application/json" \
     -d '{"description": "Admin Console Access"}'
   ```

## Architecture

The federation network consists of several components:

1. **Federation Worker**: Routes requests and handles high-level operations
2. **Federation Durable Object**: Manages source registry and handles synchronization
3. **R2 Storage**: Stores mirrored plugin files
4. **KV Storage**: Manages API keys and temporary state
5. **SQLite Database**: Stores federation state and relationships

```mermaid
graph BT
    classDef worker fill:#8b5cf6,color:#191919, stroke:#333,stroke-width:2px
    classDef do fill:#d926aa,stroke:#333,stroke-width:2px
    classDef storage fill:#d926aa,stroke:#333,stroke-width:2px
    classDef kv fill:#ad6509,stroke:#333,stroke-width:2px
    classDef external fill:#a2ff00,stroke:#191919, color:#191919, stroke-width:2px
    subgraph CoreOps["Core Operations"]
    W[Federation Worker]:::worker
    DO[Federation DO]:::do
    R2[(R2 Storage)]:::storage
    KV[(KV Storage)]:::kv
    SQL[(SQLite DB)]:::storage
    PP[Plugin Publishers]:::external
    C[Clients]:::external

    C -->|"1 - API Requests"| W
    W -->|"2 - Auth & Route"| DO
    DO -->|"3 - Store Data"| SQL
    DO -->|"4 - Mirror Plugins"| R2
    DO -->|"5 - Cache Keys"| KV
    DO -->|"6 - Verify & Sync"| PP
    PP -->|"7 - Plugin Data"| DO

        W -.->|"Handle Routes"| DO
        DO -.->|"Manage State"| SQL
        DO -.->|"Store Files"| R2:::worker
    end
```

## API Endpoints

### Administrative Endpoints
- `POST /federation/create-admin-key`: Generate new admin API key
- `POST /federation/add-source`: Register new plugin source
- `GET /federation/sources`: List all registered sources
- `POST /federation/verify-source`: Manually trigger source verification
- `GET /federation/activity`: Get federation activity feed

### Source Management
- `POST /federation/update-source`: Update source information
- `POST /federation/subscribe`: Subscribe to a source
- `GET /federation/source-status`: Get source health and sync status

### Plugin Access
- `GET /federation/plugins`: List available plugins
- `GET /federation/download`: Download mirrored plugin
- `GET /federation/verify`: Verify plugin signature

### Web Interface
The federation node includes a built-in administrative interface accessible at the root URL (`/`). This interface provides:
- Source management
- Activity monitoring
- Version tracking
- Health status overview
- Subscription management

## Source Management

### Adding a Source

Sources are added via the federation admin interface or API:

```bash
curl -X POST https://your-federation.workers.dev/federation/add-source \
  -H "Authorization: Bearer YOUR_ADMIN_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "instance_url": "https://plugins.example.com",
    "username": "plugin-author",
    "public_key": "-----BEGIN PUBLIC KEY-----\n..."
  }'
```

### Source Verification Process

```mermaid
sequenceDiagram
    participant Client
    participant Worker
    participant DO as Federation DO
    participant PP as Plugin Publisher
    participant SQL as SQLite DB

    Client->>Worker: POST /federation/verify-source
    Worker->>Worker: Authenticate Request
    Worker->>DO: Forward Verification Request
    
    DO->>PP: GET /federation-info
    PP-->>DO: Return Capabilities & Asset Info
    
    DO->>SQL: Store Asset Info
    
    DO->>PP: POST /verify-ownership
    Note right of DO: Challenge-Response Auth
    PP-->>DO: Return Signed Challenge
    
    DO->>DO: Verify Ed25519 Signature
    
    alt Verification Successful
        DO->>SQL: Update Source Status & Trust Score
        DO->>SQL: Record Verification Success
    else Verification Failed
        DO->>SQL: Record Verification Failure
    end
    
    DO-->>Worker: Return Verification Result
    Worker-->>Client: Return Response
```

### Trust Scoring

Sources are assigned trust scores based on:
- Successful verifications
- Uptime and response time
- Plugin signature validity
- Federation age
- Number of subscribers

## Version Tracking and Activity Feed

The federation node maintains an activity feed that tracks:
- Plugin version updates
- Source verifications
- Federation events
- Health status changes

Activity can be monitored via the web interface or API:
```bash
curl -X GET https://your-federation.workers.dev/federation/activity \
  -H "Authorization: Bearer YOUR_API_KEY"
```

## Plugin Mirroring
### Mirroring Process
1. Source plugins are discovered via the `/author-data` endpoint
2. Plugin files are downloaded using the source's asset naming scheme
3. Files are verified against provided signatures
4. Verified plugins are stored in R2 with metadata
### Asset Naming Scheme
Sources must provide their asset information via the `/federation-info` endpoint:
```json
{
  "assetInfo": {
    "domain": "https://assets.example.com",
    "namingScheme": "plugins/author/slug/slug.zip"
  }
}
```
## Plugin Mirroring
### Mirroring Process
1. Source plugins are discovered via the `/author-data` endpoint
2. Plugin files are downloaded using the source's asset naming scheme
3. Files are verified against provided signatures
4. Verified plugins are stored in R2 with metadata
### Asset Naming Scheme
Sources must provide their asset information via the `/federation-info` endpoint:
```json
{
  "assetInfo": {
    "domain": "https://assets.example.com",
    "namingScheme": "plugins/author/slug/slug.zip"
  }
}
```

## Subscription Management
### Subscribing to Sources

```bash
curl -X POST https://your-federation.workers.dev/federation/subscribe \
  -H "Authorization: Bearer YOUR_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "sourceId": "author@plugins.example.com",
    "filters": {
      "tags": ["utilities", "productivity"]
    }
  }'
```

### Sync Process
```mermaid
sequenceDiagram
    participant C as Client
    participant W as Worker
    participant DO as Federation DO
    participant PP as Plugin Publisher
    participant R2 as R2 Storage
    participant SQL as SQLite DB
    C->>W: POST /federation/subscribe
    W->>DO: Handle Subscribe Request
    
    DO->>SQL: Check Source Status
    
    alt Source Verified
        DO->>PP: GET /author-data
        PP-->>DO: Return Plugin List
        
        loop For Each Plugin
            DO->>DO: Apply Subscription Filters
            
            alt Plugin Matches Filters
                DO->>PP: Download Plugin
                DO->>DO: Verify Plugin Signature
                DO->>R2: Store Plugin File
                DO->>SQL: Record in mirrored_plugins
                DO->>SQL: Update version_updates
            end
        end
        
        DO->>SQL: Record Subscription
        DO->>SQL: Update Last Sync Time
    else Source Not Verified
        DO-->>W: Return Error
    end
    
    W-->>C: Return Subscription Status
```


## Database Schema

### Sources Table
```sql
CREATE TABLE sources (
  id TEXT PRIMARY KEY,              
  instance_url TEXT NOT NULL,
  username TEXT NOT NULL,
  public_key TEXT NOT NULL,
  status TEXT DEFAULT 'pending',    
  trust_score FLOAT DEFAULT 0.0,
  created_at INTEGER DEFAULT (unixepoch()),
  last_sync INTEGER,
  asset_domain TEXT,                
  asset_naming_scheme TEXT,         
  UNIQUE(instance_url, username)
);
```

### Source Verifications Table
```sql
CREATE TABLE source_verifications (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  source_id TEXT NOT NULL,
  verifier TEXT NOT NULL,
  verification_type TEXT NOT NULL,
  result TEXT NOT NULL,
  details TEXT,
  verified_at INTEGER DEFAULT (unixepoch()),
  FOREIGN KEY(source_id) REFERENCES sources(id)
);
```

### Version Updates Table
```sql
CREATE TABLE version_updates (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  plugin_id TEXT NOT NULL,
  source_id TEXT NOT NULL,
  old_version TEXT NOT NULL,
  new_version TEXT NOT NULL,
  update_time INTEGER DEFAULT (unixepoch()),
  notified BOOLEAN DEFAULT FALSE,
  FOREIGN KEY(source_id) REFERENCES sources(id)
);
```

### Mirrored Plugins Table
```sql
CREATE TABLE mirrored_plugins (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  plugin_id TEXT NOT NULL,
  source_id TEXT NOT NULL,
  name TEXT NOT NULL,
  version TEXT NOT NULL,
  description TEXT,
  local_path TEXT NOT NULL,
  signature TEXT NOT NULL,
  mirror_date INTEGER DEFAULT (unixepoch()),
  FOREIGN KEY(source_id) REFERENCES sources(id),
  UNIQUE(plugin_id, source_id, version)
);
```

## Configuration

The `wrangler.toml` configuration for a federation node:

```toml
name = "plugin-federation"
main = "src/index.js"
compatibility_date = "2024-10-22"
compatibility_flags = ["nodejs_compat"]

[[durable_objects.bindings]]
name = "FEDERATION"
class_name = "FederationDO"

[[migrations]]
tag = "v3"
new_sqlite_classes = ["FederationDO"]

[[r2_buckets]]
binding = "PLUGIN_BUCKET"
bucket_name = "federated-plugins"

[[kv_namespaces]]
binding = "FEDERATION_KV"
id = "your-kv-namespace-id"
```

## Security Considerations

### API Key Management
- Admin keys prefixed with `fadmin_`
- Keys stored in KV with metadata
- Master key for initial setup
- Regular key rotation recommended

### Source Verification
- Ed25519 signature verification
- Challenge-response ownership proof
- Regular health checks
- Trust score adjustments

### Plugin Integrity
- Original signatures preserved
- Federation layer verification
- Immutable version storage
- Version update tracking

## Best Practices

2. **Monitoring**
   - Check activity feed regularly
   - Monitor source health status
   - Track version updates
   - Review verification history

3. **Network Health**
   - Monitor node performance
   - Track synchronization status
   - Maintain backup nodes
   - Regular security audits
### Plugin Integrity
- Original signatures preserved
- Federation layer verification
- Immutable version storage
- Version update tracking

## Best Practices

1. **Source Management**
   - Regularly verify source health
   - Monitor trust scores
   - Track version updates
   - Update asset schemes when needed

2. **Monitoring**
   - Check activity feed regularly
   - Monitor source health status
   - Track version updates
   - Review verification history

3. **Network Health**
   - Monitor node performance
   - Track synchronization status
   - Maintain backup nodes
   - Regular security audits

## Contributing

Contributions are welcome soon...let me just vibe with this for a bit.


