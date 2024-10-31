
# Plugin Publisher Federation Integration Requirements

## Required Endpoints

### 1. `/federation-info` (GET)
Primary endpoint for federation capability discovery and asset information.

```json
{
  "version": "1.0.0",
  "features": ["plugin-distribution", "signature-verification"],
  "assetInfo": {
    "domain": "https://assets.example.com",
    "namingScheme": "plugins/author/slug/slug.zip"
  }
}
```

### 2. `/verify-ownership` (POST)
Handles challenge-response authentication for source verification.

**Request:**
```json
{
  "username": "plugin-author",
  "challenge": "uuid-challenge-string"
}
```

**Response:**
```json
{
  "signature": "base64-encoded-ed25519-signature"
}
```

### 3. `/author-data` (GET)
Provides plugin information for a specific author.

**Query Parameters:**
- `author`: Username of the plugin author

**Response:**
```json
{
  "username": "plugin-author",
  "member_since": "2024-01-01",
  "website": "https://example.com",
  "github": "github-username",
  "twitter": "twitter-handle",
  "plugins": [
    {
      "slug": "plugin-id",
      "name": "Plugin Name",
      "version": "1.0.0",
      "short_description": "Plugin description",
      "tags": {
        "category1": "utilities",
        "category2": "productivity"
      },
      "icons": {
        "1x": "icon-url.png",
        "2x": "icon-url@2x.png"
      },
      "rating": 4.5,
      "active_installs": 1000
    }
  ]
}
```

## Security Requirements

### 1. Ed25519 Key Pair Generation
- Generate an Ed25519 key pair for signing plugins and challenges
- Store private key securely
- Make public key available for federation nodes

### 2. Plugin Signing
Each plugin release must be signed with the publisher's Ed25519 private key:
1. Create a message containing plugin metadata:
```json
{
  "id": "plugin-slug",
  "name": "Plugin Name",
  "version": "1.0.0",
  "description": "Plugin description"
}
```
2. Sign the UTF-8 encoded JSON with Ed25519
3. Include base64-encoded signature with plugin metadata

### 3. Challenge-Response Authentication
- Accept challenge strings from federation nodes
- Sign challenges with Ed25519 private key
- Return base64-encoded signatures

## Asset Storage Requirements

### 1. Consistent Asset Naming
- Implement predictable URL structure for plugin files
- Follow the declared `namingScheme` format
- Ensure URLs are publicly accessible

### 2. Version Management
- Maintain all published versions
- Don't remove old versions
- Include version in asset path

## Plugin Metadata Requirements

### 1. Required Plugin Fields
- `slug`: Unique identifier
- `name`: Display name
- `version`: Semantic version
- `short_description`: Brief description
- `tags`: Categorization
- `signature`: Ed25519 signature

### 2. Optional Plugin Fields
- `icons`: Plugin icons in various sizes
- `rating`: User rating
- `active_installs`: Installation count

## Implementation Checklist

1. Server Setup:
   - [ ] Configure Ed25519 key pair
   - [ ] Set up secure key storage
   - [ ] Implement required endpoints

2. Plugin Processing:
   - [ ] Add signature generation to release process
   - [ ] Implement version tracking
   - [ ] Set up asset storage with proper naming

3. Federation Support:
   - [ ] Implement challenge-response authentication
   - [ ] Add federation capability reporting
   - [ ] Set up author data endpoint

4. Security:
   - [ ] Secure private key storage
   - [ ] Implement signature verification
   - [ ] Add request validation

5. Monitoring:
   - [ ] Track federation requests
   - [ ] Monitor sync status
   - [ ] Log verification attempts

## Example Implementation Notes

1. Initialize Ed25519 keys:
```javascript
const crypto = require('crypto');
const { privateKey, publicKey } = crypto.generateKeyPairSync('ed25519');
```

2. Sign a challenge:
```javascript
function signChallenge(challenge, privateKey) {
  const message = Buffer.from(challenge);
  const signature = crypto.sign(null, message, privateKey);
  return signature.toString('base64');
}
```

3. Sign plugin metadata:
```javascript
function signPluginMetadata(plugin, privateKey) {
  const message = JSON.stringify({
    id: plugin.slug,
    name: plugin.name,
    version: plugin.version,
    description: plugin.short_description
  });
  const signature = crypto.sign(null, Buffer.from(message), privateKey);
  return signature.toString('base64');
}
```

4. Federation info endpoint:
```javascript
app.get('/federation-info', (req, res) => {
  res.json({
    version: '1.0.0',
    features: ['plugin-distribution', 'signature-verification'],
    assetInfo: {
      domain: 'https://assets.example.com',
      namingScheme: 'plugins/author/slug/slug.zip'
    }
  });
});
```