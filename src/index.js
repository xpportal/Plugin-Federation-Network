import { FederationDO } from "./federation-do";

export { FederationDO };

// index.js
export default {
	async fetch(request, env, ctx) {
		try {
			const url = new URL(request.url);
			const federation = env.FEDERATION.get(env.FEDERATION.idFromName('federation'));

			// Standardize path handling - remove leading/trailing slashes and split
			const path = url.pathname.replace(/^\/+|\/+$/g, '');
			const pathParts = path.split('/');

			// Route handling
			switch (path) {
				case '':
					return await handleAdminPage(request);
				case 'federation/update-source':
					return federation.fetch(new Request('http://federation/update-source', {
						method: request.method,
						headers: request.headers,
						body: request.body
					}));
				case 'federation/create-admin-key':
					if (request.method !== 'POST') {
						return new Response('Method not allowed', { status: 405 });
					}

					// Only allow creation if there's a master key or no keys exist yet
					const authHeader = request.headers.get('Authorization');
					const masterKey = env.MASTER_KEY;
					if (masterKey && (!authHeader || authHeader !== `Bearer ${masterKey}`)) {
						return new Response('Unauthorized', { status: 401 });
					}

					try {
						const { description } = await request.json();
						const adminKey = `fadmin_${crypto.randomUUID().replace(/-/g, '')}`;

						await env.FEDERATION_KV.put(`admin:${adminKey}`, JSON.stringify({
							created: Date.now(),
							description
						}));

						return new Response(JSON.stringify({
							key: adminKey,
							description,
							created: Date.now()
						}), {
							headers: { 'Content-Type': 'application/json' }
						});
					} catch (error) {
						return new Response(JSON.stringify({ error: error.message }), {
							status: 500,
							headers: { 'Content-Type': 'application/json' }
						});
					}

				case 'federation/sources':
					// Pass the actual path to the DO without the internal prefix
					return federation.fetch(new Request('http://federation/sources', {
						method: request.method,
						headers: request.headers
					}));

				case 'federation/activity':
					if (!await authenticateRequest(request, env)) {
						return new Response('Unauthorized', { status: 401 });
					}
					return federation.fetch(new Request('http://federation/activity', {
						method: 'GET',
						headers: {
							...Object.fromEntries(request.headers),
							'Content-Type': 'application/json'
						}
					}));
				//@todo debug if this is needed in the future. may be to true up versions if someone decrements the version number.
				// case 'sync-versions':
				// 	return federation.fetch(new Request('http://federation/sync-versions', {
				// 		method: request.method,
				// 		headers: request.headers
				// 	}));
				case 'federation/subscribe':
					if (!await authenticateRequest(request, env)) {
						return new Response('Unauthorized', { status: 401 });
					}
					return federation.fetch(new Request('http://federation/subscribe', {
						method: 'POST',
						body: request.body,
						headers: {
							...Object.fromEntries(request.headers),
							'Content-Type': 'application/json',
							'X-User': 'test-user' // For testing
						}
					}));

				case 'federation/verify-source':
					if (!await authenticateRequest(request, env)) {
						return new Response('Unauthorized', { status: 401 });
					}
					return federation.fetch(new Request('http://federation/verify-source', {
						method: 'POST',
						body: request.body,
						headers: {
							...Object.fromEntries(request.headers),
							'Content-Type': 'application/json',
							'X-User': 'test-user'
						}
					}));

				case 'federation/add-source':
					if (request.method !== 'POST') {
						return new Response('Method not allowed', { status: 405 });
					}

					// Validate admin API key
					if (!await authenticateRequest(request, env)) {
						return new Response(JSON.stringify({ error: 'Unauthorized' }), {
							status: 401,
							headers: { 'Content-Type': 'application/json' }
						});
					}
					return handleAddSource(request, env);

				default:
					console.log(`No route found for path: ${path}`);
					return new Response('Not Found', {
						status: 404,
						headers: { 'Content-Type': 'application/json' }
					});
			}
		} catch (error) {
			console.error('Error:', error);
			return new Response(JSON.stringify({ error: error.message }), {
				status: 500,
				headers: { 'Content-Type': 'application/json' }
			});
		}
	}
};

// Auth helper
async function validateApiKey(apiKey, env) {
	if (apiKey === env.SECRET_KEY) return true;

	// Check admin keys in KV
	const adminKeyData = await env.FEDERATION_KV.get(`admin:${apiKey}`);
	return !!adminKeyData;
}

// Update authenticate to pass env
async function authenticateRequest(request, env) {
	const authHeader = request.headers.get('Authorization');
	if (!authHeader?.startsWith('Bearer ')) {
		return false;
	}

	const token = authHeader.split(' ')[1];
	return await validateApiKey(token, env);
}

// Add source handler
async function handleAddSource(request, env) {
	try {
		// Already authenticated at this point
		const { instance_url, username, public_key } = await request.json();

		if (!instance_url || !username || !public_key) {
			return new Response(JSON.stringify({
				error: 'Missing required fields'
			}), {
				status: 400,
				headers: { 'Content-Type': 'application/json' }
			});
		}

		const sourceId = `${username}@${new URL(instance_url).hostname}`;

		// Pass to federation DO to store
		const federation = env.FEDERATION.get(env.FEDERATION.idFromName('federation'));
		const result = await federation.fetch(new Request('http://federation/add-source', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({
				id: sourceId,
				instance_url,
				username,
				public_key,
				added_by: request.headers.get('X-Admin-User') || 'admin',
				added_at: Date.now()
			})
		}));

		if (!result.ok) {
			throw new Error(await result.text());
		}

		// Store in KV for quick lookups
		await env.FEDERATION_KV.put(`source:${sourceId}`, JSON.stringify({
			instance_url,
			username,
			public_key,
			status: 'pending',
			added_at: Date.now()
		}));

		return new Response(JSON.stringify({
			success: true,
			source_id: sourceId,
			status: 'pending',
			message: 'Source added successfully, pending verification'
		}), {
			headers: { 'Content-Type': 'application/json' }
		});

	} catch (error) {
		return new Response(JSON.stringify({
			error: 'Failed to add source',
			details: error.message
		}), {
			status: 500,
			headers: { 'Content-Type': 'application/json' }
		});
	}
}

// Route handlers
async function handleAdminPage(request, env) {
	return new Response(getAdminHTML(), {
		headers: {
			'Content-Type': 'text/html',
			'Cache-Control': 'no-store'
		}
	});
}



function getAdminHTML() {
	// Note the use of backticks for the outer template literal
	return `
	  <!DOCTYPE html>
	  <html lang="en">
	  <head>
		<title>Federation Management</title>
		<meta charset="UTF-8">
		<meta name="viewport" content="width=device-width, initial-scale=1.0">
		<link 
		  href="https://cdn.jsdelivr.net/npm/tailwindcss@2.2.19/dist/tailwind.min.css" 
		  rel="stylesheet"
		>
	  </head>
	  <body class="min-h-screen bg-gradient-to-r from-blue-500 to-purple-900 py-8 text-white">
		<div class="container mx-auto px-4">
		  <div class="max-w-4xl mx-auto">
			<div class="bg-gray-900 rounded-lg shadow-xl p-8">
			  <h1 class="text-2xl font-bold mb-6 text-center">Plugin Federation Manager</h1>
			  
			  <!-- Message Area -->
			  <div id="messageArea" class="mb-4 text-center hidden"></div>
  
			  <!-- Auth Panel -->
			  <div id="authPanel">
				<form id="apiKeyForm" class="space-y-4">
				  <div>
					<label class="block text-sm font-medium mb-2">API Key</label>
					<input
					  type="password"
					  id="apiKeyInput"
					  required
					  class="w-full px-4 py-2 rounded bg-gray-800 border border-gray-700 focus:border-purple-500 focus:ring-1 focus:ring-purple-500 outline-none transition text-white"
					>
				  </div>
				  <button
					type="submit"
					class="w-full bg-purple-600 hover:bg-purple-700 font-medium py-2 px-4 rounded"
				  >
					Connect to Federation
				  </button>
				</form>
			  </div>
  
			  <!-- Main Panel -->
			  <div id="mainPanel" class="hidden">
				<div class="mb-8 flex items-center justify-between bg-gray-800 p-4 rounded">
				  <div>
					<span class="text-sm text-gray-400">Current API Key:</span>
					<span id="currentApiKey" class="ml-2 font-mono"></span>
				  </div>
				  <form id="addSourceForm" class="mb-8 p-4 bg-gray-800 rounded">
					<h3 class="text-lg font-medium mb-4">Add Plugin Source</h3>
					<div class="space-y-4">
					  <div>
						<label class="block text-sm font-medium mb-2">Instance URL</label>
						<input
						  type="url"
						  name="instance_url"
						  required
						  placeholder="https://plugin-publisher.your-domain.com"
						  class="w-full px-4 py-2 rounded bg-gray-700 border border-gray-600 focus:border-purple-500 focus:ring-1 focus:ring-purple-500 outline-none transition"
						>
					  </div>
					  <div>
						<label class="block text-sm font-medium mb-2">Username</label>
						<input
						  type="text"
						  name="username"
						  required
						  placeholder="plugin-author"
						  class="w-full px-4 py-2 rounded bg-gray-700 border border-gray-600 focus:border-purple-500 focus:ring-1 focus:ring-purple-500 outline-none transition"
						>
					  </div>
					  <div>
						<label class="block text-sm font-medium mb-2">Public Key</label>
						<textarea
						  name="public_key"
						  required
						  placeholder="-----BEGIN PUBLIC KEY-----..."
						  class="w-full px-4 py-2 rounded bg-gray-700 border border-gray-600 focus:border-purple-500 focus:ring-1 focus:ring-purple-500 outline-none transition h-32"
						></textarea>
					  </div>
					</div>
					<button
					  type="submit"
					  class="mt-4 bg-green-600 hover:bg-green-700 font-medium py-2 px-4 rounded"
					>
					  Add Source
					</button>
				  </form>
				</div>
  
				<!-- Sources Table -->
				<div class="overflow-x-auto">
				  <h3 class="text-lg font-medium mb-4">Federation Sources</h3>
				  <table class="w-full text-sm">
					<thead>
					  <tr class="text-left">
						<th class="px-4 py-2">Instance URL</th>
						<th class="px-4 py-2">Username</th>
						<th class="px-4 py-2">Status</th>
						<th class="px-4 py-2">Actions</th>
					  </tr>
					</thead>
					<tbody id="sourcesTable"></tbody>
				  </table>
				</div>
				<div class="mt-8">
					<h3 class="text-lg font-medium mb-4">Federation Activity</h3>
					<div id="activityFeed" class="space-y-4"></div>
				</div>
			  </div>
			</div>
		  </div>
		</div>
  
		<script>
		async function refreshActivityFeed() {
			try {
				const response = await fetch('/federation/activity', {
				headers: {
					'Authorization': 'Bearer ' + federationConfig.apiKey
				}
				});
				
				if (!response.ok) throw new Error('Failed to fetch activity');
				
				const activities = await response.json();
				updateActivityFeed(activities);
			} catch (error) {
				console.error('Error refreshing activity:', error);
			}
			}

			function updateActivityFeed(activities) {
			const feed = document.getElementById('activityFeed');
			feed.innerHTML = activities.map(activity => {
				const time = new Date(activity.timestamp * 1000).toLocaleString();
				
				if (activity.type === 'version_update') {
				return \`
					<div class="bg-gray-800 p-4 rounded">
					<div class="flex items-center">
						<span class="text-green-400">⟳</span>
						<span class="ml-2">
						<strong>\${activity.plugin_name}</strong> updated from 
						<code class="px-1 bg-gray-700 rounded">\${activity.old_version}</code> to 
						<code class="px-1 bg-green-700 rounded">\${activity.new_version}</code>
						by \${activity.source_username}
						</span>
					</div>
					<div class="text-xs text-gray-400 mt-1">\${time}</div>
					</div>
				\`;
				}
				
				if (activity.type === 'source_verification') {
				return \`
					<div class="bg-gray-800 p-4 rounded">
					<div class="flex items-center">
						<span class="text-blue-400">✓</span>
						<span class="ml-2">
						Source <strong>\${activity.source_username}</strong> verified
						</span>
					</div>
					<div class="text-xs text-gray-400 mt-1">\${time}</div>
					</div>
				\`;
				}
			}).join('');
			}

			// Update refresh interval to include activity
			setInterval(() => {
			if (federationConfig.apiKey) {
				refreshSourcesList();
				refreshActivityFeed();
			}
			}, 30000); // Every 30 seconds

		  // Federation management
		  let federationConfig = JSON.parse(localStorage.getItem('federationConfig') || JSON.stringify({
			apiKey: '',
			lastSync: null,
			sources: []
		  }));
  
		  async function handleApiKeySubmit(e) {
			e.preventDefault();
			const apiKey = document.getElementById('apiKeyInput').value;
			
			try {
			  const response = await fetch('/federation/sources', {
				headers: {
				  'Authorization': 'Bearer ' + apiKey
				}
			  });
			  
			  if (!response.ok) throw new Error('Invalid API key');
			  
			  federationConfig.apiKey = apiKey;
			  federationConfig.lastSync = new Date().toISOString();
			  localStorage.setItem('federationConfig', JSON.stringify(federationConfig));
			  
			  toggleAuthPanel(true);
			  await refreshSourcesList();
			  showMessage('API key saved successfully', 'success');
			} catch (error) {
			  showMessage('Failed to validate API key: ' + error.message, 'error');
			}
		  }
  
		  document.getElementById('addSourceForm').addEventListener('submit', async (e) => {
			e.preventDefault();
			const formData = new FormData(e.target);
			
			try {
			  const response = await fetch('/federation/add-source', {
				method: 'POST',
				headers: {
				  'Authorization': 'Bearer ' + federationConfig.apiKey,
				  'Content-Type': 'application/json'
				},
				body: JSON.stringify({
				  instance_url: formData.get('instance_url'),
				  username: formData.get('username'),
				  public_key: formData.get('public_key')
				})
			  });
			  
			  if (!response.ok) throw new Error('Failed to add source');
			  
			  showMessage('Source added successfully', 'success');
			  e.target.reset();
			  await refreshSourcesList();
			} catch (error) {
			  showMessage('Failed to add source: ' + error.message, 'error');
			}
		  });
  
		  function toggleAuthPanel(isAuthenticated) {
			document.getElementById('authPanel').classList.toggle('hidden', isAuthenticated);
			document.getElementById('mainPanel').classList.toggle('hidden', !isAuthenticated);
			
			if (isAuthenticated) {
			  document.getElementById('currentApiKey').textContent = 
				federationConfig.apiKey.slice(0, 8) + '...' + federationConfig.apiKey.slice(-4);
			}
		  }
  
		  async function refreshSourcesList() {
			try {
			  if (!federationConfig.apiKey) {
				throw new Error('No API key available');
			  }
			  
			  const response = await fetch('/federation/sources', {
				headers: {
				  'Authorization': 'Bearer ' + federationConfig.apiKey
				}
			  });
			  
			  if (!response.ok) {
				const errorText = await response.text();
				throw new Error(\`Server returned \${response.status}: \${errorText}\`);
			  }
			  
			  const sources = await response.json();
			  updateSourcesTable(sources);
			} catch (error) {
			  console.error('Error refreshing sources:', error);
			  showMessage('Failed to refresh sources: ' + error.message, 'error');
			}
		  }
  
		  async function verifySource(sourceId) {
			try {
			  const response = await fetch('/federation/verify-source', {
				method: 'POST',
				headers: {
				  'Authorization': 'Bearer ' + federationConfig.apiKey,
				  'Content-Type': 'application/json'
				},
				body: JSON.stringify({ sourceId })
			  });
			  
			  if (!response.ok) throw new Error('Failed to verify source');
			  
			  showMessage('Source verified successfully', 'success');
			  await refreshSourcesList();
			} catch (error) {
			  showMessage('Failed to verify source: ' + error.message, 'error');
			}
		  }
  
		  async function subscribeToSource(sourceId) {
			try {
			  const response = await fetch('/federation/subscribe', {
				method: 'POST',
				headers: {
				  'Authorization': 'Bearer ' + federationConfig.apiKey,
				  'Content-Type': 'application/json'
				},
				body: JSON.stringify({ sourceId })
			  });
			  
			  if (!response.ok) throw new Error('Failed to subscribe to source');
			  
			  showMessage('Subscribed to source successfully', 'success');
			  await refreshSourcesList();
			} catch (error) {
			  showMessage('Failed to subscribe: ' + error.message, 'error');
			}
		  }
  
		  function updateSourcesTable(sources) {
			const tbody = document.getElementById('sourcesTable');
			tbody.innerHTML = sources.map((source) => \`
			  <tr class="border-t border-gray-700">
				<td class="px-4 py-2">
				  <div>
					<div class="font-medium">\${source.instance_url}</div>
					<div class="text-xs text-gray-400">
					  Last Sync: <span class="px-2 py-1 rounded-full text-xs 'bg-green-800'">\${source.last_sync || 'unknown'}</span>
					</div>
				  </div>
				</td>
				<td class="px-4 py-2">
				  <div>
					<div>\${source.username}</div>
					<div class="text-xs text-gray-400">Trust: \${(source.trust_score || 0).toFixed(2)}</div>
				  </div>
				</td>
				<td class="px-4 py-2">
				  <div>
					<div>\${source.status}</div>
					<div class="text-xs text-gray-400">
					  \${source.plugin_count || 0} plugins • \${source.subscriber_count || 0} subscribers
					</div>
					\${source.response_time_avg ? 
					  \`<div class="text-xs text-gray-400">Response: \${source.response_time_avg}ms</div>\` : 
					  ''}
				  </div>
				</td>
				<td class="px-4 py-2">
				  <button
					onclick="subscribeToSource('\${source.id}')"
					class="bg-green-600 hover:bg-green-700 text-white px-2 py-1 rounded text-xs"
				  >
					Subscribe
				  </button>
				  \${source.status === 'pending' ? \`
					<button
					  onclick="verifySource('\${source.id}')"
					  class="ml-2 bg-blue-600 hover:bg-blue-700 text-white px-2 py-1 rounded text-xs"
					>
					  Verify
					</button>
				  \` : ''}
				</td>
			  </tr>
			\`).join('');
		  }
  
		  function showMessage(message, type = 'success') {
			const messageEl = document.getElementById('messageArea');
			messageEl.innerHTML = type === 'success' 
			  ? '<span class="text-green-400">✓ ' + message + '</span>'
			  : '<span class="text-red-400">⚠ ' + message + '</span>';
			
			messageEl.classList.remove('hidden');
			setTimeout(() => {
			  messageEl.classList.add('hidden');
			}, 3000);
		  }
  
		  // Initialize
		  document.addEventListener('DOMContentLoaded', function() {
			const storedConfig = localStorage.getItem('federationConfig');
			if (storedConfig) {
			  try {
				federationConfig = JSON.parse(storedConfig);
				if (federationConfig.apiKey) {
				  toggleAuthPanel(true);
				  setTimeout(refreshSourcesList, 100);
				} else {
				  toggleAuthPanel(false);
				}
			  } catch (error) {
				console.error('Failed to parse stored config:', error);
				toggleAuthPanel(false);
			  }
			} else {
			  toggleAuthPanel(false);
			}
  
			document.getElementById('apiKeyForm').addEventListener('submit', handleApiKeySubmit);
		  });
		</script>
	  </body>
	  </html>
	`;
}