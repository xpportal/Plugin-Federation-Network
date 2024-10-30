import { verify, etc } from '@noble/ed25519';
import { sha512 } from '@noble/hashes/sha512';

etc.sha512Sync = (...m) => sha512(etc.concatBytes(...m));

export class FederationDO {
	constructor(state, env) {
		this.state = state;
		this.env = env;
		this.sql = state.storage.sql;
	}

	async initializeSchema() {
		try {
			await this.sql.exec(`
			CREATE TABLE IF NOT EXISTS sources (
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
			`);

			// Create subscriptions table
			await this.sql.exec(`
			CREATE TABLE IF NOT EXISTS subscriptions (
				id INTEGER PRIMARY KEY AUTOINCREMENT,
				source_id TEXT NOT NULL,
				subscriber TEXT NOT NULL,         
				filters TEXT,                     
				created_at INTEGER DEFAULT (unixepoch()),
				FOREIGN KEY(source_id) REFERENCES sources(id),
				UNIQUE(source_id, subscriber)
			);
			`);

			// Create mirrored_plugins table
			await this.sql.exec(`
			CREATE TABLE IF NOT EXISTS mirrored_plugins (
			id INTEGER PRIMARY KEY AUTOINCREMENT,
			plugin_id TEXT NOT NULL,          -- original plugin ID
			source_id TEXT NOT NULL,
			name TEXT NOT NULL,
			version TEXT NOT NULL,
			description TEXT,
			local_path TEXT NOT NULL,         -- path in R2
			signature TEXT NOT NULL,          -- source signature
			mirror_date INTEGER DEFAULT (unixepoch()),
			FOREIGN KEY(source_id) REFERENCES sources(id),
			UNIQUE(plugin_id, source_id, version)
			);
		`);

			// Create source_verifications table
			await this.sql.exec(`
			CREATE TABLE IF NOT EXISTS source_verifications (
			id INTEGER PRIMARY KEY AUTOINCREMENT,
			source_id TEXT NOT NULL,
			verifier TEXT NOT NULL,           -- who verified
			verification_type TEXT NOT NULL,  -- initial, periodic, manual
			result TEXT NOT NULL,             -- success, failure
			details TEXT,                     -- verification details
			verified_at INTEGER DEFAULT (unixepoch()),
			FOREIGN KEY(source_id) REFERENCES sources(id)
			);
      	`);

			// Create indices
			await this.sql.exec(`
		-- Index for sorting sources by trust score
		CREATE INDEX IF NOT EXISTS idx_sources_trust 
		ON sources(trust_score DESC);

		-- Index for accessing mirrored plugins by source
		CREATE INDEX IF NOT EXISTS idx_mirrored_plugins_source 
		ON mirrored_plugins(source_id, mirror_date DESC);

		-- Index for accessing subscriptions by subscriber
		CREATE INDEX IF NOT EXISTS idx_subscriptions_subscriber 
		ON subscriptions(subscriber, created_at DESC);
		`);

		} catch (error) {
			console.error("Error initializing federation schema:", error);
			throw error;
		}
	}

	async handleSources(request) {
		try {
			const sources = await this.sql.exec(`
        SELECT 
          s.*,
          COUNT(DISTINCT sub.subscriber) as subscriber_count,
          COUNT(DISTINCT mp.id) as plugin_count,
          (
            SELECT result 
            FROM source_verifications 
            WHERE source_id = s.id 
            ORDER BY verified_at DESC 
            LIMIT 1
          ) as last_verification_result,
          (
            SELECT COUNT(*) 
            FROM source_verifications 
            WHERE source_id = s.id 
            AND result = 'success'
          ) as successful_verifications
        FROM sources s
        LEFT JOIN subscriptions sub ON sub.source_id = s.id
        LEFT JOIN mirrored_plugins mp ON mp.source_id = s.id
        GROUP BY s.id
        ORDER BY s.trust_score DESC, s.created_at DESC
      `).toArray();

			return new Response(JSON.stringify(sources), {
				headers: { 'Content-Type': 'application/json' }
			});
		} catch (error) {
			console.error('Error fetching sources:', error);
			throw error;
		}
	}

	async verifyPluginSignature(plugin, signature, publicKey) {
		try {
			const message = new TextEncoder().encode(
				JSON.stringify({
					id: plugin.id,
					name: plugin.name,
					version: plugin.version,
					description: plugin.description
				})
			);

			const publicKeyBytes = this.parsePublicKey(publicKey);
			const signatureBytes = this.parseSignature(signature);

			return await verify(signatureBytes, message, publicKeyBytes);
		} catch (error) {
			console.error('Error verifying plugin signature:', error);
			return false;
		}
	}

	async checkInstanceHealth(instanceUrl) {
		try {
			console.log('Checking health of instance:', instanceUrl);
			const response = await fetch(`${instanceUrl}/federation-info`);

			if (!response.ok) {
				console.log('Instance health check failed:', response.status);
				return { isUp: false, details: `HTTP ${response.status}` };
			}

			const info = await response.json();
			console.log('Instance health info detailed:', {
				info,
				assetInfo: info.assetInfo,
				domain: info?.assetInfo?.domain,
				scheme: info?.assetInfo?.namingScheme
			});

			return {
				isUp: true,
				info,
				details: 'Instance responded successfully'
			};
		} catch (error) {
			console.error('Instance health check error:', error);
			return { isUp: false, details: error.message };
		}
	}

	parsePublicKey(publicKey) {
		try {
			// Clean up the key - handle both single-line and multi-line formats
			const cleanKey = publicKey
				.replace('-----BEGIN PUBLIC KEY-----', '')
				.replace('-----END PUBLIC KEY-----', '')
				.replace(/\s+/g, ''); // Remove all whitespace

			console.log("Cleaned key length:", cleanKey.length);

			// Attempt to decode the base64
			const keyBytes = Buffer.from(cleanKey, 'base64');
			console.log("Decoded key length:", keyBytes.length);

			// Handle PKCS8/SPKI format which includes metadata before the key
			if (keyBytes.length > 32) {
				// Extract the actual key portion - it's usually the last 32 bytes
				const actualKey = keyBytes.slice(-32);
				console.log("Extracted key length:", actualKey.length);
				return new Uint8Array(actualKey);
			}

			return new Uint8Array(keyBytes);
		} catch (error) {
			console.error('Error parsing public key:', error);
			throw new Error(`Failed to parse public key: ${error.message}`);
		}
	}

	parseSignature(signature) {
		try {
			// Decode base64 signature
			const signatureBytes = Buffer.from(signature, 'base64');

			// Ed25519 signatures should be 64 bytes
			if (signatureBytes.length !== 64) {
				throw new Error('Invalid signature length');
			}

			return new Uint8Array(signatureBytes);
		} catch (error) {
			console.error('Error parsing signature:', error);
			throw new Error(`Failed to parse signature: ${error.message}`);
		}
	}


	// Source management methods
	async addSource({ instance_url, username, public_key }) {
		try {
			const sourceId = `${username}@${new URL(instance_url).hostname}`;

			// Verify the instance is running a compatible plugin publisher
			const healthCheck = await this.verifyInstance(instance_url);
			if (!healthCheck.isCompatible) {
				throw new Error('Incompatible plugin publisher instance');
			}

			// Insert the source
			await this.sql.exec(`
        INSERT INTO sources (
          id, instance_url, username, public_key,
          status, created_at
        ) VALUES (?, ?, ?, ?, 'pending', unixepoch())
      `, sourceId, instance_url, username, public_key);

			// Schedule initial verification
			await this.verifySource(sourceId);

			return { success: true, sourceId };
		} catch (error) {
			console.error('Error adding source:', error);
			throw error;
		}
	}

	async recordVerificationAttempt(sourceId, health, keyVerification) {
		console.log('big attempt!:', sourceId, health, keyVerification);
		const verificationDetails = JSON.stringify({ health, keyVerification });
		const verificationResult = health.isUp && keyVerification ? 'success' : 'failure';

		console.log('Recording verification with params:', {
			sourceId,
			verifier: 'system',
			verificationType: 'initial',
			result: verificationResult,
			details: verificationDetails
		});

		try {
			const query = `
			INSERT INTO source_verifications (
			  source_id,
			  verifier,
			  verification_type,
			  result,
			  details
			) VALUES (
			  '${sourceId}',
			  'system',
			  'initial',
			  '${verificationResult}',
			  '${verificationDetails.replace(/'/g, "''")}'
			)`;

			await this.sql.exec(query);

		} catch (error) {
			console.error('SQL Error details:', {
				error,
				query
			});
			throw error;
		}
	}

	// Update verifySource to use the new recording method
	async verifySource(sourceId) {
		try {
			console.log('Starting source verification for:', sourceId);

			const sourceCursor = await this.sql.exec(
				`SELECT * FROM sources WHERE id = '${sourceId}'`
			);

			const sources = sourceCursor.toArray();
			if (!sources || sources.length === 0) {
				console.log('No source found with ID:', sourceId);
				return false;
			}

			const source = sources[0];
			console.log('Found source to verify:', source);

			// Verify the instance is online and responding
			const health = await this.checkInstanceHealth(source.instance_url);
			console.log('Health check result:', health);

			// Store asset info if available
			if (health.isUp && health.info?.assetInfo) {
				console.log('Updating source with asset info:', health.info.assetInfo);
				const updateAssetQuery = `
				  UPDATE sources 
				  SET 
					asset_domain = '${health.info.assetInfo.domain}',
					asset_naming_scheme = '${health.info.assetInfo.namingScheme}'
				  WHERE id = '${sourceId}'
				`;
				console.log('Running update asset query:', updateAssetQuery);
				await this.sql.exec(updateAssetQuery);

				// Verify the update worked
				const verifyUpdate = await this.sql.exec(`
				  SELECT asset_domain, asset_naming_scheme 
				  FROM sources 
				  WHERE id = '${sourceId}'
				`).toArray();
				console.log('Asset info after update:', verifyUpdate[0]);
			}

			const keyVerification = await this.verifyPublicKeyOwnership(
				source.instance_url,
				source.username,
				source.public_key
			);

			console.log('Key verification result:', keyVerification);

			await this.recordVerificationAttempt(sourceId, health, keyVerification);

			// Update source status if verification succeeded
			if (health.isUp && keyVerification) {
				console.log('Verification successful, updating source status');
				const updateQuery = `
			  UPDATE sources 
			  SET status = 'verified', 
				  trust_score = 0.5 
			  WHERE id = '${sourceId}'
			`;
				await this.sql.exec(updateQuery);
				return true;
			}

			return false;
		} catch (error) {
			console.error('Error in verifySource:', error);
			console.error('Stack:', error.stack);
			return false;
		}
	}

	async getSourceStatus(sourceId) {
		try {
			console.log('Checking status for source:', sourceId);

			const query = 'SELECT * FROM sources WHERE id = ?';
			console.log('Running query:', query, 'with params:', [sourceId]);

			const cursor = await this.sql.exec(query, [sourceId]);
			console.log('Raw cursor:', cursor);

			// Get all rows using the cursor's array method
			const rows = cursor.toArray();
			console.log('Result rows:', rows);

			if (!rows || rows.length === 0) {
				console.log('No source found with id:', sourceId);
				return { exists: false };
			}

			const source = rows[0];
			console.log('Found source:', source);

			return {
				exists: true,
				status: source.status || 'unknown',
				instance_url: source.instance_url,
				username: source.username,
				trust_score: source.trust_score || 0
			};
		} catch (error) {
			console.error('Error checking source status:', error);
			throw error;
		}
	}

	// Replace handleSubscribe method
	async handleSubscribe(sourceId, subscriber, filters = {}) {
		try {
			console.log('Starting subscription process for:', { sourceId, subscriber });

			// First verify the source exists and is verified
			const verifiedSourceQuery = `
			SELECT * FROM sources 
			WHERE id = '${sourceId}' 
			AND status = 'verified'
		  `;
			console.log('Running verified source query:', verifiedSourceQuery);

			const sourceCursor = await this.sql.exec(verifiedSourceQuery);
			const sources = sourceCursor.toArray();
			console.log('Source query results:', sources);

			if (!sources || sources.length === 0) {
				console.log('No verified source found for:', sourceId);
				throw new Error(`Source ${sourceId} not found or not verified`);
			}

			const sourceData = sources[0];
			console.log('Found verified source:', sourceData);

			// Add or update subscription - convert the filters object to a JSON string and escape any single quotes
			const filtersJson = JSON.stringify(filters).replace(/'/g, "''");
			const subscriptionQuery = `
			INSERT OR REPLACE INTO subscriptions (
			  source_id, subscriber, filters, created_at
			) VALUES (
			  '${sourceId}',
			  '${subscriber}',
			  '${filtersJson}',
			  unixepoch()
			)
		  `;
			console.log('Running subscription query:', subscriptionQuery);

			await this.sql.exec(subscriptionQuery);
			console.log('Subscription created/updated successfully');

			// Initial sync of plugins matching filters
			const syncResult = await this.syncSourcePlugins(sourceId, filters);
			console.log('Initial sync completed:', syncResult);

			return {
				success: true,
				message: 'Subscription created and initial sync completed',
				source: sourceData,
				syncResult
			};
		} catch (error) {
			console.error('Subscription error:', error);
			throw error;
		}
	}


	// Add this helper method to check if a subscription exists
	async checkSubscriptionExists(sourceId, subscriber) {
		const result = await this.sql.exec(
			'SELECT 1 FROM subscriptions WHERE source_id = ? AND subscriber = ?',
			[sourceId, subscriber]
		);
		return result && result.length > 0;
	}

	async mirrorPlugin(plugin, source) {
		try {
			console.log('Mirroring plugin:', { plugin, source });

			// Check if we already have this version
			const existingQuery = `
			SELECT 1 FROM mirrored_plugins
			WHERE plugin_id = '${plugin.id}' 
			AND source_id = '${source.id}' 
			AND version = '${plugin.version}'
		  `;
			const existing = await this.sql.exec(existingQuery);

			if (existing && existing.length > 0) {
				console.log('Plugin version already mirrored');
				return true;
			}

			// Use stored asset info
			if (!source.asset_domain || !source.asset_naming_scheme) {
				throw new Error('Source asset information not available');
			}

			// Construct download URL using the naming scheme
			const pluginPath = source.asset_naming_scheme
				.replace('author', source.username)
				.replace(/slug/g, plugin.id);

			const downloadUrl = new URL(pluginPath, source.asset_domain);
			console.log('Constructed download URL:', downloadUrl.toString());

			// Fetch plugin zip
			const pluginResponse = await fetch(downloadUrl.toString());
			if (!pluginResponse.ok) {
				throw new Error(`Failed to fetch plugin: HTTP ${pluginResponse.status}`);
			}

			// Store in R2
			const path = `federated/${source.id}/${plugin.id}-${plugin.version}`;
			await this.env.PLUGIN_BUCKET.put(
				path,
				await pluginResponse.arrayBuffer()
			);

			// Record in database with additional metadata
			const insertQuery = `
			INSERT INTO mirrored_plugins (
			  plugin_id, source_id, name, version,
			  description, local_path, signature
			) VALUES (
			  '${plugin.id}',
			  '${source.id}',
			  '${plugin.name.replace(/'/g, "''")}',
			  '${plugin.version}',
			  '${(plugin.description || '').replace(/'/g, "''")}',
			  '${path}',
			  '${plugin.signature || ''}'
			)
		  `;
			await this.sql.exec(insertQuery);

			console.log('Successfully mirrored plugin:', plugin.name);
			return true;
		} catch (error) {
			console.error('Error mirroring plugin - Full details:', {
				error: {
					message: error.message,
					stack: error.stack,
					name: error.name
				},
				plugin: plugin.name,
				source: source.id,
				hasAssetInfo: {
					domain: !!source.asset_domain,
					scheme: !!source.asset_naming_scheme
				}
			});
			return false;
		}
	}

	async updateSourceInfo(sourceId) {
		try {
			const sourceCursor = await this.sql.exec(
				`SELECT * FROM sources WHERE id = '${sourceId}'`
			);

			const sources = sourceCursor.toArray();
			if (!sources || sources.length === 0) {
				throw new Error('Source not found');
			}

			const source = sources[0];
			console.log('Updating source info for:', source);

			// Get fresh federation info
			const response = await fetch(`${source.instance_url}/federation-info`);
			const info = await response.json();
			console.log('Fresh federation info:', info);

			if (info.assetInfo) {
				const updateQuery = `
			  UPDATE sources 
			  SET 
				asset_domain = '${info.assetInfo.domain}',
				asset_naming_scheme = '${info.assetInfo.namingScheme}'
			  WHERE id = '${sourceId}'
			`;
				await this.sql.exec(updateQuery);

				// Verify update
				const updated = await this.sql.exec(
					`SELECT * FROM sources WHERE id = '${sourceId}'`
				).toArray();
				console.log('Updated source:', updated[0]);

				return {
					success: true,
					message: 'Source asset info updated',
					source: updated[0]
				};
			} else {
				throw new Error('No asset info in federation response');
			}
		} catch (error) {
			console.error('Error updating source:', error);
			throw error;
		}
	}

	async syncSourcePlugins(sourceId, filters = {}) {
		try {
			const sourceQuery = `SELECT * FROM sources WHERE id = '${sourceId}'`;
			const sourceCursor = await this.sql.exec(sourceQuery);
			const sources = sourceCursor.toArray();

			if (!sources || sources.length === 0) {
				throw new Error('Source not found');
			}

			const source = sources[0];
			console.log('Found source for plugin sync:', source);

			// Build URL for author data
			const authorDataUrl = new URL('/author-data', source.instance_url);
			authorDataUrl.searchParams.set('author', source.username);
			console.log(`Attempting to fetch author data from ${authorDataUrl.toString()}`);

			try {
				const response = await fetch(authorDataUrl.toString());
				console.log('Author data fetch response:', {
					status: response.status,
					statusText: response.statusText,
					ok: response.ok,
					url: response.url
				});

				if (!response.ok) {
					const errorText = await response.text();
					throw new Error(`HTTP ${response.status}: ${errorText}`);
				}

				const authorData = await response.json();
				console.log(`Successfully fetched author data with ${authorData.plugins.length} plugins`);

				// Transform the plugins data to match our expected format
				const plugins = authorData.plugins.map(plugin => ({
					id: plugin.slug,
					name: plugin.name,
					version: plugin.version,
					description: plugin.short_description,
					tags: Object.values(plugin.tags || {}),
					icons: plugin.icons,
					rating: plugin.rating,
					active_installs: plugin.active_installs
				}));

				// Filter plugins based on subscription filters
				const filteredPlugins = this.filterPlugins(plugins, filters);
				console.log(`Filtered to ${filteredPlugins.length} plugins based on filters:`, {
					originalCount: plugins.length,
					filteredCount: filteredPlugins.length,
					appliedFilters: filters
				});

				// Mirror each plugin
				let mirroredCount = 0;
				for (const plugin of filteredPlugins) {
					const mirrorSuccess = await this.mirrorPlugin(plugin, source);
					if (mirrorSuccess) mirroredCount++;
				}

				// Update last sync time
				const updateQuery = `
			  UPDATE sources 
			  SET last_sync = unixepoch()
			  WHERE id = '${sourceId}'
			`;
				await this.sql.exec(updateQuery);

				return {
					success: true,
					mirroredCount,
					totalPlugins: filteredPlugins.length,
					authorInfo: {
						username: authorData.username,
						memberSince: authorData.member_since,
						website: authorData.website,
						github: authorData.github,
						twitter: authorData.twitter
					}
				};
			} catch (fetchError) {
				console.error('Plugin fetch error details:', fetchError);
				throw new Error(`Failed to fetch plugins: ${fetchError.message}`);
			}
		} catch (error) {
			console.error('Error syncing plugins:', error);
			throw error;
		}
	}


	// Helper methods
	async verifyInstance(instanceUrl) {
		try {
			const response = await fetch(`${instanceUrl}/federation-info`);
			if (!response.ok) return { isCompatible: false };

			const info = await response.json();
			return {
				isCompatible: true,
				version: info.version,
				features: info.features
			};
		} catch (error) {
			return { isCompatible: false };
		}
	}

	async verifyPublicKeyOwnership(instanceUrl, username, publicKey) {
		try {
			// Request a challenge
			const challenge = crypto.randomUUID();
			console.log('Starting key verification with:', {
				instanceUrl,
				username,
				challenge
			});

			// First check what auth headers are accepted
			const optionsResponse = await fetch(`${instanceUrl}/verify-ownership`, {
				method: 'OPTIONS'
			});
			console.log('OPTIONS response:', {
				status: optionsResponse.status,
				headers: Object.fromEntries(optionsResponse.headers.entries())
			});

			// Get signed challenge from instance
			const response = await fetch(`${instanceUrl}/verify-ownership`, {
				method: 'POST',
				headers: {
					'Content-Type': 'application/json',
				},
				body: JSON.stringify({ username, challenge })
			});

			console.log('Verification response:', {
				status: response.status,
				statusText: response.statusText
			});

			const responseText = await response.text();
			console.log('Response body:', responseText);

			if (!response.ok) {
				console.log('Verification failed:', responseText);
				return false;
			}

			const { signature } = JSON.parse(responseText);
			console.log('Got signature:', signature);

			// Verify signature using ed25519
			const message = new TextEncoder().encode(challenge);
			const publicKeyBytes = this.parsePublicKey(publicKey);
			const signatureBytes = this.parseSignature(signature);

			return await verify(signatureBytes, message, publicKeyBytes);
		} catch (error) {
			console.error('Error verifying key ownership:', error);
			console.error('Stack:', error.stack);
			return false;
		}
	}


	filterPlugins(plugins, filters) {
		if (!filters || Object.keys(filters).length === 0) return plugins;

		return plugins.filter(plugin => {
			// Filter by tags if specified
			if (filters.tags && filters.tags.length > 0) {
				const pluginTags = new Set(plugin.tags || []);
				return filters.tags.some(tag => pluginTags.has(tag));
			}
			return true;
		});
	}

	// Request handlers
	async fetch(request) {
		if (!this.schemaInitialized) {
			await this.initializeSchema();
			this.schemaInitialized = true;
		}

		const url = new URL(request.url);
		const path = url.pathname;

		console.log('FederationDO handling path:', path);

		try {
			switch (path) {
				case '/sources':
					return await this.handleSources(request);

				case '/add-source': {
					const { instance_url, username, public_key } = await request.json();
					const result = await this.addSource({
						instance_url,
						username,
						public_key
					});
					return new Response(JSON.stringify(result), {
						headers: { 'Content-Type': 'application/json' }
					});
				}
				case '/update-source': {
					const { sourceId } = await request.json();
					const updateResult = await this.updateSourceInfo(sourceId);
					return new Response(JSON.stringify(updateResult), {
						headers: { 'Content-Type': 'application/json' }
					});
				}
				case '/verify-source': {
					const { sourceId } = await request.json();
					const verified = await this.verifySource(sourceId);
					return new Response(JSON.stringify({ success: verified }), {
						headers: { 'Content-Type': 'application/json' }
					});
				}

				case '/subscribe': {
					const { sourceId, filters } = await request.json();
					const subscriber = request.headers.get('X-User');

					// Debug: Check source status before attempting subscription
					const sourceStatus = await this.getSourceStatus(sourceId);
					console.log('Source status before subscription:', sourceStatus);

					if (!sourceStatus.exists) {
						return new Response(JSON.stringify({
							error: 'Source not found',
							details: { sourceId, sourceStatus }
						}), {
							status: 404,
							headers: { 'Content-Type': 'application/json' }
						});
					}

					const subscribeResult = await this.handleSubscribe(sourceId, subscriber, filters);
					return new Response(JSON.stringify(subscribeResult), {
						headers: { 'Content-Type': 'application/json' }
					});
				}

				default:
					console.log(`FederationDO: No handler for path: ${path}`);
					return new Response(JSON.stringify({ error: 'Not Found' }), {
						status: 404,
						headers: { 'Content-Type': 'application/json' }
					});
			}
		} catch (error) {
			console.error('Federation DO Error:', error);
			return new Response(JSON.stringify({ error: error.message }), {
				status: 500,
				headers: { 'Content-Type': 'application/json' }
			});
		}
	}

}
