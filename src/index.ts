import { Router } from 'itty-router';
import { Buffer } from 'node:buffer';
import { toType, toRcode } from './dnsUtils';
import base64url from 'base64url';
import * as dnsPacket from '@dnsquery/dns-packet';
import Config from '../config.json';
import Resolvers from '../resolvers.json';
import Package from '../package-lock.json';

const router = Router();

Array.prototype.sample = function(){
	return this[Math.floor(Math.random()*this.length)];
}

Array.prototype.sampleN = function(n: any) {
	var result = new Array(n),
		len = this.length,
		taken = new Array(len);
	if (n > len)
		throw new RangeError("getRandom: more elements taken than available");
	while (n--) {
		var x = Math.floor(Math.random() * len);
		result[n] = this[x in taken ? taken[x] : x];
		taken[x] = --len in taken ? taken[len] : len;
	}
	return result;
}

async function getDNSResponse(url: any, env: any, family: any) {
	let p: any = new URL(url).hostname;
	try {
		let r: any = await fetch(url, {
			headers: {
				'Content-Type': 'application/dns-message'
			}
		})

		if (r.status !== 200) {
			// Log non-200 response to Error Analytics Engine
			env.ERROR_ANALYTICS.writeDataPoint({
				'blobs': [p, `HTTP_${r.status}`], 
				'doubles': [r.status],
				'indexes': [family]
			});
			throw new Error(`HTTP ${r.status} from ${p}`);
		}
		return r;
	} catch (e: any) {
		// Log fetch errors to Analytics Engine
		let errorType = 'FETCH_ERROR';
		if (e.name === 'TypeError') errorType = 'NETWORK_ERROR';
		if (e.message.includes('timeout')) errorType = 'TIMEOUT_ERROR';
		if (e.message.includes('DNS')) errorType = 'DNS_ERROR';

		env.ERROR_ANALYTICS.writeDataPoint({
			'blobs': [p, errorType], 
			'doubles': [],
			'indexes': [family]
		});
		throw e;
	}
}

// Scheduled task to update resolver health scores in KV
async function updateResolverHealthScores(env: any) {
	// Extract families from config.json keys
	const configFamilies = Object.keys(Config).map(key => {
		if (key === 'default') return 'freedom'; // default maps to freedom
		if (key.endsWith('.mydns.network')) {
			return key.split('.')[0]; // Extract family name (adblock, family, paranoia)
		}
		return null;
	}).filter(f => f !== null);
	
	let dataset = 'prod';
	if (env.ANALYTICS.toString().includes('dev')) dataset = 'dev';
	
	for (let family of configFamilies) {
		try {
			// Start with all configured resolvers at perfect health (100)
			let healthScores: any = {};
			
			// Get all resolvers for this family from config
			for (let configKey of Object.keys(Config)) {
				let configResolvers = Config[configKey as keyof typeof Config].resolvers;
				for (let resolverKey of configResolvers) {
					let resolverConfig = Resolvers[resolverKey as keyof typeof Resolvers];
					if (resolverConfig && (resolverConfig as any)[family]) {
						let hostname = new URL((resolverConfig as any)[family]).hostname;
						healthScores[hostname] = 100; // Start at perfect health
					}
				}
			}
			
			// Query recent error rates from Analytics Engine
			let query = `SELECT blob1 AS provider, COUNT() AS error_count FROM 'mydnsproxy-errors-${dataset}' WHERE index1 = '${family}' AND timestamp > NOW() - INTERVAL '2' HOUR GROUP BY provider;`;
			
			let response = await fetch(`https://api.cloudflare.com/client/v4/accounts/${env.CLOUDFLARE_ACCOUNT_ID}/analytics_engine/sql`, {
				method: 'POST',
				body: query,
				headers: {
					'Authorization': `Bearer ${env.CLOUDFLARE_ACCOUNT_TOKEN}`,
				}
			});
			
			if (response.status === 200) {
				let data = await response.json();
				
				// Apply error penalties to base health scores
				for (let row of (data as any).data) {
					let provider = row.provider;
					let errorCount = parseInt(row.error_count);
					
					// Only apply penalty if this provider is in our configured resolvers
					if (healthScores.hasOwnProperty(provider)) {
						// Health score: start at 100, subtract (error_count * penalty), minimum 1
						healthScores[provider] = Math.max(1, 100 - (errorCount * 0.1));
					}
				}
			}
			
			// Store in KV with 10 minute TTL
			await env.RESOLVER_HEALTH.put(`health-scores-${family}`, JSON.stringify(healthScores), {
				expirationTtl: 600 // 10 minutes
			});
			
			console.log(`Updated health scores for ${family}:`, Object.keys(healthScores).length, 'providers');
		} catch (e) {
			console.log(`Failed to update health scores for ${family}:`, e);
		}
	}
}

async function getResolverHealthScores(env: any, family: any) {
	try {
		// Fast KV lookup
		let healthData = await env.RESOLVER_HEALTH.get(`health-scores-${family}`, 'json');
		return healthData || {};
	} catch (e) {
		console.log(`Failed to get health scores for ${family}:`, e);
		return {};
	}
}

function weightedSample(resolvers: any, healthScores: any, family: any, n: any) {
	// Calculate weights for each resolver
	let weightedResolvers = resolvers.map((r: any) => {
		let resolverUrl = Resolvers[r]?.[family];
		if (!resolverUrl) return { resolver: r, weight: 0 };
		
		let hostname = new URL(resolverUrl).hostname;
		let health = healthScores[hostname] || 50; // Default health score
		
		return { resolver: r, weight: health };
	}).filter((wr: any) => wr.weight > 0);
	
	if (weightedResolvers.length === 0) return resolvers.slice(0, n);
	
	// Select n resolvers based on weighted probability
	let selected = [];
	let totalWeight = weightedResolvers.reduce((sum: number, wr: any) => sum + wr.weight, 0);
	
	for (let i = 0; i < Math.min(n, weightedResolvers.length); i++) {
		let random = Math.random() * totalWeight;
		let cumulative = 0;
		
		for (let wr of weightedResolvers) {
			cumulative += wr.weight;
			if (random <= cumulative) {
				selected.push(wr.resolver);
				// Remove selected resolver to avoid duplicates
				weightedResolvers = weightedResolvers.filter((x: any) => x.resolver !== wr.resolver);
				totalWeight -= wr.weight;
				break;
			}
		}
	}
	
	return selected.length > 0 ? selected : resolvers.slice(0, n);
}

async function chooseResolvers(resolvers: any, q: any, family: any = "freedom", n: any = 3, env: any) {
	let p = [];
	
	// Get current health scores
	let healthScores = await getResolverHealthScores(env, family);
	
	// Select resolvers using weighted sampling based on health
	let selectedResolvers;
	if (Object.keys(healthScores).length > 0) {
		selectedResolvers = weightedSample(resolvers, healthScores, family, n);
	} else {
		// Fallback to random selection if no health data
		selectedResolvers = resolvers.length > n ? resolvers.sampleN(n) : resolvers;
	}
	
	// Create DNS requests for selected resolvers
	for (let r of selectedResolvers) {
		try {
			p.push(getDNSResponse(`${Resolvers[r][family]}?dns=${q}`, env, family))
		}
		catch(e: any) {}
	}

	return p;
}

function getRandomInt (min: any, max: any) {
	return Math.floor(Math.random() * (max - min + 1)) + min
}

router.all('/resolve', async (request, env, context) => {
	// First, grab some request information
	let url: any = new URL(request.url)

	// Now, we refuse anything that isn't GET or POST
	if (!['GET', 'POST'].includes(request.method)) {
		return new Response('Not Found.', { status: 404 })
	}

	let name: any;
	let rrtype: any = 'A';

	if (request.method == 'GET') {
		if (request.query.name) name = request.query.name || null;
		if (request.query.type) {
			const typeParam = Array.isArray(request.query.type) ? request.query.type[0] : request.query.type;
			rrtype = typeParam.toUpperCase();
		}

		if (name == null) return new Response('Missing name in ?name=', { status: 400 })
		
	}

	if (!['A', 'AAAA', 'DNSKEY', 'MX', 'NS', 'SRV', 'TXT'].includes(rrtype)) return new Response('Unsupported rrtype', { status: 400 })

	// Next, we need to prepare a query with DNSSEC enforcement
	let query: any = dnsPacket.encode({
		type: 'query',
		id: getRandomInt(1, 65534),
		flags: dnsPacket.RECURSION_DESIRED, // CD flag is NOT set, enforcing DNSSEC validation
		additionals: [{
			type: 'OPT',
			name: '.',
			class: 4096, // UDP payload size is set via class field for OPT records
			flags: dnsPacket.DNSSEC_OK // Request DNSSEC records
		}],
		questions: [{
			type: rrtype,
			name: name
		}]
	})
	query = base64url(query);

	// Next, we prepare to send it on, first pick a resolver (by default, we use the default)
	let resolver: any = Config['default'].resolvers
	if (Config[url.hostname]) {
		// Check now for a resolvers set for the hostname the request came in on
		resolver = Config[url.hostname].resolvers
	}

	// We also have to determine the resolver family, by default, freedom
	let family = "freedom"
	if (url.hostname.includes('.mydns.network')) {
		family = url.hostname.split('.')[0];
	}
	if (family == "paranoia") family = "freedom";

	let providers = await chooseResolvers(resolver, query, family, 3, env);
	
	// And send it off
	let answer: any;
	try {
		answer = await Promise.any(providers);
	}
	catch(e: any) {
		console.log('ERROR in /resolve:', e);
		return new Response('We encountered a server error. Please try again later', { status: 500 })
	}

	// Once we have an answer, we read it in
	let decoded: any = await answer.arrayBuffer();
	decoded = Buffer.from(decoded);

	// And next, we decode it
	decoded = dnsPacket.decode(decoded);
	
	// Now, we need to prepare the response
	let resp: any = {}

	// Initially, did the query even work?
	resp.Status = toRcode(decoded.rcode);

	// Next, we'll add some flags
	for (let key of Object.keys(decoded)) {
		if (key.includes('flag_')) {
			if (['AD', 'CD', 'RA', 'RD', 'TC'].includes(key.replaceAll('flag_', '').toUpperCase())) {
				resp[key.replaceAll('flag_', '').toUpperCase()] = decoded[key]
			}
		}
	}

	// And the question
	resp.Question = [];
	for (let q of decoded.questions) {
		resp.Question.push({
			'name': `${q.name}.`,
			'type': toType(q.type)
		})
	};


	// Now, we determine if there is an answer to give
	if (decoded.answers.length > 0) {
		resp.Answer = [];
		for (let ans of decoded.answers) {

			let r: any = {
				'name': `${ans.name}.`,
				'type': toType(ans.type),
				'TTL': ans.ttl,
				'data': ans.data
			}

			if (['DNSKEY'].includes(ans.type)) r.data = `${ans.data.flags} ${ans.data.algorithm} ${btoa(String.fromCharCode.apply(null, ans.data.key))}`;
			if (['TXT'].includes(ans.type)) r.data = ans.data[0].toString()
			if (['SRV'].includes(ans.type)) r.data = `${ans.data.priority} ${ans.data.weight} ${ans.data.port} ${ans.data.target}.`

			resp.Answer.push(r)
		}
	}
	if (decoded.answers.length == 0) {
		resp.Authority = [];
		for (let auth of decoded.authorities) {
			resp.Authority.push({
				'name': auth.name,
				'type': toType(auth.type),
				'TTL': auth.ttl,
				'data': `${auth.data.mname}. ${auth.data.rname}. ${auth.data.serial} ${auth.data.refresh} ${auth.data.retry} ${auth.data.expire} ${auth.data.minimum}`
			})
		}
	}

	// And a comment from where it came from
	let prov: any = new URL(answer.url).hostname;
	// In order to check how we're doing responses, we'll log the provider and the resolver to identify issues
	env.ANALYTICS.writeDataPoint({
		'blobs': [prov], // We log what provider was used
		'doubles': [],
		'indexes': [family] // And what resolver family was used
	});
	resp.Comment = `Response from ${prov}`

	return new Response(JSON.stringify(resp), { headers: { 'Content-Type': 'application/json'}})
})

router.all('/dns-query', async (request, env, context) => {
	// First, grab some request information
	let url: any = new URL(request.url)

	// Now, we refuse anything that isn't GET or POST
	if (!['GET', 'POST'].includes(request.method)) {
		return new Response('Not Found.', { status: 404 })
	}

	// And grab the question
	let q: any = null;
	if (request.method == 'GET') {
		if (request.query.dns) {
			q = request.query.dns;
		}
		else {
			return new Response('Missing query in ?dns=', { status: 400 })
		}
	}
	if (request.method == 'POST') {
		q = await request.arrayBuffer();
		q = Buffer.from(q);
	}

	// Decode, modify for DNSSEC enforcement, and re-encode the query
	let decodedQuery: any;
	try {
		if (request.method == 'GET') {
			decodedQuery = dnsPacket.decode(base64url.toBuffer(q));
		} else {
			decodedQuery = dnsPacket.decode(q);
		}
		
		// Enforce DNSSEC: ensure CD flag is NOT set
		decodedQuery.flags = decodedQuery.flags & ~dnsPacket.CHECKING_DISABLED; // Clear CD flag
		decodedQuery.flags = decodedQuery.flags | dnsPacket.RECURSION_DESIRED; // Ensure RD is set
		
		// Add minimal EDNS0 with DNSSEC_OK flag
		if (!decodedQuery.additionals) {
			decodedQuery.additionals = [];
		}
		
		decodedQuery.additionals.push({
			type: 'OPT',
			name: '.',
			class: 512, // Smaller UDP payload size
			flags: dnsPacket.DNSSEC_OK
		});
		
		// Re-encode and convert to base64url
		q = base64url(dnsPacket.encode(decodedQuery));
		
	} catch (e: any) {
		console.log('DEBUG: DNSSEC enforcement failed:', e.message);
		// Fall back to original query if modification fails
		if (request.method == 'POST') {
			q = base64url(q);
		}
	}

	// Next, we prepare to send it on, first pick a resolver (by default, we use the default)
	let resolver: any = Config['default'].resolvers
	if (Object.keys(Config).includes(url.hostname)) {
		// Check now for a resolvers set for the hostname the request came in on
		resolver = Config[url.hostname].resolvers
	}

	// We also have to determine the resolver family, by default, freedom
	let family = "freedom"
	if (url.hostname.includes('.mydns.network')) {
		family = url.hostname.split('.')[0];
	}
	if (family == "paranoia") family = "freedom";

	let providers = await chooseResolvers(resolver, q, family, 3, env);
	
	// And send it off
	let answer: any;
	let a: any;
	try {
		answer = await Promise.any(providers);
		a = await answer.arrayBuffer();
	}
	catch(e: any) {
		console.log('ERROR in /dns-query:', e);
		// So if we get here, something happened, so we'll try and build our own response
		return new Response(`We encountered an error while performing this lookup: ${e}`, { status: 500 });
	}

	// Next, log the usage to Analytics Engine
	let prov: any = new URL(answer.url).hostname;
	env.ANALYTICS.writeDataPoint({
		'blobs': [prov], // We log what provider was used
		'doubles': [],
		'indexes': [family] // And what resolver family was used
	});

	// And if we need a debug issue
	if (request.url.includes('?debug')) console.log(new URL(answer.url).hostname)
	return new Response(a, {
		headers: {
			'Content-Type': answer.headers.get('Content-Type'),
			'X-Provider': new URL(answer.url).hostname
		},
		status: answer.status
	})
})

router.get('/dns-providers', async (request) => {

	// First, grab some request information
	let url: any = new URL(request.url);

	// Now, prepare a payload
	let resp: any = {
		'providers': []
	}

	// Next, we prepare to send it on, first pick a resolver (set to our default set)
	let resolver: any = Config['default'].resolvers;
	if (Config[url.hostname]) {
		// Check now for a resolvers set for the hostname the request came in on
		resolver = Config[url.hostname].resolvers
	}
	
	let family = "freedom"
	if (url.hostname.includes('.mydns.network')) {
		family = url.hostname.split('.')[0];
	}
	if (family == "paranoia") family = "freedom";
	
	// Add each provider to the response, so they can be seen
	for (let r of resolver) {
		if (Resolvers[r][family]) resp.providers.push(Resolvers[r][family])
	}

	// And return that data
	return new Response(JSON.stringify(resp, null, 2), { headers: {'Content-Type': 'application/json'}})
})

router.get('/version', async (request) => {
	return new Response(Package.version, {
		headers: {
			'Content-Type': 'text/plain'
		}
	})
});

router.get('/resolver-usage', async (request, env) => {
	// First, we grab the hostname they asked for
	let url: any = new URL(request.url);

	// Check the hostname is valid
	let family = "freedom"
	if (url.hostname.includes('.mydns.network')) {
		family = url.hostname.split('.')[0];
	}
	if (family == "paranoia") family = "freedom";

	// Now we select the right dataset
	let dataset: any = 'prod'
	if (url.hostname.includes('.staging.')) dataset = 'dev'

	// Next, we query today's use from Analytics Engine
	let resp: any = {}

	try {
		let query = `SELECT blob1 AS resolver, sum(_sample_interval) AS count FROM 'mydnsproxy-${dataset}' WHERE index1 = '${family}' AND timestamp > NOW() - INTERVAL '1' DAY GROUP BY resolver ORDER BY count DESC;`
		let data: any = await fetch(`https://api.cloudflare.com/client/v4/accounts/${env.CLOUDFLARE_ACCOUNT_ID}/analytics_engine/sql`, {
			method: 'POST',
			body: query,
			headers: {
				'Authorization': `Bearer ${env.CLOUDFLARE_ACCOUNT_TOKEN}`,
			}
		})
		if (data.status !== 200) return {}
		data = await data.json();

		resp.data = data.data;
	}
	catch(e: any) {}

	return new Response(JSON.stringify(resp, null, 2), { headers: {'Content-Type': 'application/json'}})
})

router.get('/error-analytics', async (request, env) => {
	let url: any = new URL(request.url);
	
	// Parse query parameters
	const hours = parseInt(url.searchParams.get('hours') || '24');
	const queryType = url.searchParams.get('type') || 'error-rates';
	
	// Check the hostname is valid and determine dataset
	let family = "freedom"
	if (url.hostname.includes('.mydns.network')) {
		family = url.hostname.split('.')[0];
	}
	if (family == "paranoia") family = "freedom";

	let dataset = 'prod'
	if (url.hostname.includes('.staging.')) dataset = 'dev'

	let resp: any = { queryType, hours, dataset }

	try {
		let query = '';
		
		switch (queryType) {
			case 'error-rates':
				query = `SELECT blob1 AS provider, blob2 AS error_type, index1 AS resolver_family, COUNT() AS error_count FROM 'mydnsproxy-errors-${dataset}' WHERE timestamp > NOW() - INTERVAL '${hours}' HOUR GROUP BY provider, error_type, resolver_family ORDER BY error_count DESC;`;
				break;
				
			case 'http-errors':
				query = `SELECT blob1 AS provider, blob2 AS error_type, double1 AS http_status, COUNT() AS occurrences FROM 'mydnsproxy-errors-${dataset}' WHERE blob2 LIKE 'HTTP_%' AND timestamp > NOW() - INTERVAL '${hours}' HOUR GROUP BY provider, error_type, http_status ORDER BY occurrences DESC;`;
				break;
				
			case 'reliability':
				query = `SELECT blob1 AS provider, index1 AS resolver_family, COUNT() AS error_count FROM 'mydnsproxy-errors-${dataset}' WHERE timestamp > NOW() - INTERVAL '${hours}' HOUR GROUP BY provider, resolver_family ORDER BY error_count DESC;`;
				break;
				
			case 'error-types':
				query = `SELECT blob1 AS provider, CASE WHEN blob2 = 'NETWORK_ERROR' THEN 'Network Issues' WHEN blob2 = 'TIMEOUT_ERROR' THEN 'Timeout Issues' WHEN blob2 LIKE 'HTTP_%' THEN 'HTTP Errors' WHEN blob2 = 'DNS_ERROR' THEN 'DNS Resolution' ELSE 'Other' END AS issue_category, COUNT() AS count FROM 'mydnsproxy-errors-${dataset}' WHERE timestamp > NOW() - INTERVAL '${hours}' HOUR GROUP BY provider, issue_category ORDER BY provider, count DESC;`;
				break;
				
			default:
				return new Response(JSON.stringify({
					error: 'Invalid query type',
					validTypes: ['error-rates', 'http-errors', 'reliability', 'error-types']
				}), { status: 400, headers: {'Content-Type': 'application/json'}});
		}

		let data: any = await fetch(`https://api.cloudflare.com/client/v4/accounts/${env.CLOUDFLARE_ACCOUNT_ID}/analytics_engine/sql`, {
			method: 'POST',
			body: query,
			headers: {
				'Authorization': `Bearer ${env.CLOUDFLARE_ACCOUNT_TOKEN}`,
			}
		})
		
		if (data.status !== 200) {
			resp.error = `Analytics API returned ${data.status}`;
		} else {
			data = await data.json();
			resp.data = data.data;
			resp.meta = data.meta;
		}
	}
	catch(e: any) {
		resp.error = e.message;
	}

	return new Response(JSON.stringify(resp, null, 2), { headers: {'Content-Type': 'application/json'}})
})

// Static asset routes
router.get('/style.css', async (request, env) => {
	return env.ASSETS.fetch(request);
});

router.get('/', async (request, env) => {
	const url = new URL(request.url);
	
	// Serve static index.html for main domain
	if (url.hostname === 'mydns.network' || !url.hostname.includes('.mydns.network')) {
		return env.ASSETS.fetch(new Request(`${url.origin}/index.html`));
	}
	
	// Dynamic resolver pages for subdomains
	const hostname = url.hostname;
	let resolver: any = Config['default'].resolvers;
	
	if (Config[hostname as keyof typeof Config]) {
		resolver = Config[hostname as keyof typeof Config].resolvers;
	}

	let family = "freedom"
	if (hostname.includes('.mydns.network')) {
		family = hostname.split('.')[0];
	}
	if (family == "paranoia") family = "freedom";

	// Get resolver URLs
	const resolvers: string[] = [];
	for (let r of resolver) {
		const resolverConfig = Resolvers[r as keyof typeof Resolvers];
		if (resolverConfig && (resolverConfig as any)[family]) {
			resolvers.push((resolverConfig as any)[family]);
		}
	}

	// Fetch template and perform substitutions
	const templateResponse = await env.ASSETS.fetch(new Request(`${url.origin}/resolver.html`));
	let template = await templateResponse.text();
	
	template = template.replaceAll('[HOSTNAME]', hostname);
	template = template.replaceAll('[NAME]', hostname.replace('.mydns.network', ''));
	template = template.replaceAll('[RESOLVERS]', resolvers.join('\n'));

	return new Response(template, {
		headers: {
			'Content-Type': 'text/html'
		}
	});
});

router.all("*", () => new Response("404, not found!", { status: 404 }))

export default {
	fetch: router.fetch,
	
	// Scheduled task handler
	async scheduled(event: any, env: any, ctx: any) {
		console.log('Running scheduled health score update...');
		await updateResolverHealthScores(env);
		console.log('Health score update completed');
	}
}