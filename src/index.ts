import { Router } from 'itty-router';
import { Buffer } from 'node:buffer';
import { chooseResolvers, createDNSQuery, enforceDNSSEC } from './dnsResolver';
import { updateResolverHealthScores, getResolverHealthScores, executeAnalyticsQuery, buildAnalyticsQuery, logUsageAnalytics } from './analytics';
import { parseRequestContext, validateDNSQueryType, parseQueryParameters } from './requestUtils';
import { processDNSResponse, extractProviderHostname } from './dnsProcessor';
import { CloudflareEnv, DNSResponse, ErrorAnalyticsResponse, HealthScoreResponse, APIError } from './types';
import { getResolverFamily } from './utils';
import base64url from 'base64url';
import * as dnsPacket from '@dnsquery/dns-packet';
import Config from '../config.json';
import Resolvers from '../resolvers.json';
import Package from '../package-lock.json';

const router = Router();

router.all('/resolve', async (request, env: CloudflareEnv, ctx) => {
	// Parse request context (hostname, family, resolvers, etc.)
	const url = new URL(request.url);
	const requestContext = parseRequestContext(url);

	// Validate HTTP method
	if (!['GET', 'POST'].includes(request.method)) {
		return new Response('Not Found.', { status: 404 });
	}

	// Parse query parameters
	const { name, type: rrtype } = parseQueryParameters(url);
	
	if (request.method === 'GET' && !name) {
		return new Response('Missing name in ?name=', { status: 400 });
	}

	if (!validateDNSQueryType(rrtype)) {
		return new Response('Unsupported rrtype', { status: 400 });
	}

	// Create DNS query with DNSSEC enforcement
	const query = createDNSQuery(name!, rrtype);

	// Choose resolvers using intelligent selection
	const providers = await chooseResolvers(
		requestContext.resolvers, 
		query, 
		requestContext.resolverFamily, 
		3, 
		env, 
		getResolverHealthScores
	);
	
	// And send it off
	let answer: any;
	try {
		answer = await Promise.any(providers);
	}
	catch(e: any) {
		console.log('ERROR in /resolve:', e);
		return new Response('We encountered a server error. Please try again later', { status: 500 })
	}

	// Process DNS response
	const arrayBuffer = await answer.arrayBuffer();
	const buffer = Buffer.from(arrayBuffer);
	const decoded = dnsPacket.decode(buffer);
	
	// Process the response using optimized processor
	const resp: DNSResponse = processDNSResponse(decoded, answer.url);

	// Log usage analytics
	const providerHostname = extractProviderHostname(answer.url);
	logUsageAnalytics(env, providerHostname, requestContext.family);

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
	try {
		let decodedQuery: any;
		if (request.method == 'GET') {
			decodedQuery = dnsPacket.decode(base64url.toBuffer(q));
		} else {
			decodedQuery = dnsPacket.decode(q);
		}
		
		// Enforce DNSSEC
		decodedQuery = enforceDNSSEC(decodedQuery);
		
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
	family = getResolverFamily(family);

	let providers = await chooseResolvers(resolver, q, family, 3, env, getResolverHealthScores);
	
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

	// Log usage analytics
	let prov: any = new URL(answer.url).hostname;
	logUsageAnalytics(env, prov, family);

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
	family = getResolverFamily(family);
	
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
	family = getResolverFamily(family);

	// Now we select the right dataset
	let dataset: any = 'prod'
	if (url.hostname.includes('.staging.')) dataset = 'dev'

	// Next, we query today's use from Analytics Engine
	let resp: any = {}

	try {
		let query = `SELECT blob1 AS resolver, sum(_sample_interval) AS count FROM 'mydnsproxy-${dataset}' WHERE index1 = '${family}' AND timestamp > NOW() - INTERVAL '1' DAY GROUP BY resolver ORDER BY count DESC;`
		let result = await executeAnalyticsQuery(query, env);
		
		if (result.error) {
			resp.error = result.error;
		} else {
			resp.data = result.data;
		}
	}
	catch(e: any) {
		resp.error = e.message;
	}

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
	family = getResolverFamily(family);

	let dataset = 'prod'
	if (url.hostname.includes('.staging.')) dataset = 'dev'

	let resp: any = { queryType, hours, dataset }

	try {
		const query = buildAnalyticsQuery(queryType, hours, dataset);
		const result = await executeAnalyticsQuery(query, env);
		
		if (result.error) {
			resp.error = result.error;
		} else {
			resp.data = result.data;
			resp.meta = result.meta;
		}
	}
	catch(e: any) {
		if (e.message === 'Invalid query type') {
			return new Response(JSON.stringify({
				error: 'Invalid query type',
				validTypes: ['error-rates', 'http-errors', 'reliability', 'error-types', 'combined-health']
			}), { status: 400, headers: {'Content-Type': 'application/json'}});
		}
		resp.error = e.message;
	}

	return new Response(JSON.stringify(resp, null, 2), { headers: {'Content-Type': 'application/json'}})
})

router.get('/health-scores', async (request, env) => {
	let url: any = new URL(request.url);
	
	// Determine family from hostname
	let family = "freedom"
	if (url.hostname.includes('.mydns.network')) {
		family = url.hostname.split('.')[0];
	}
	
	try {
		// Get combined health scores from KV
		let healthData = await env.RESOLVER_HEALTH.get('health-scores', 'json');
		
		if (!healthData || Object.keys(healthData).length === 0) {
			return new Response(JSON.stringify({
				error: 'No health data available',
				message: 'Health scores may still be generating. Please try again in a few minutes.'
			}), { headers: {'Content-Type': 'application/json'}});
		}
		
		// Get resolvers used by this family
		let resolver: any = Config['default'].resolvers;
		let configKey = url.hostname;
		
		// Map staging hostnames to production config keys
		if (url.hostname.includes('.staging.mydns.network')) {
			configKey = url.hostname.replace('.staging.mydns.network', '.mydns.network');
		}
		
		if (Config[configKey]) {
			resolver = Config[configKey].resolvers;
		}
		
		// Filter health scores to only include resolvers used by this family
		let familyHealthScores: any = {};
		for (let resolverKey of resolver) {
			let resolverConfig = Resolvers[resolverKey as keyof typeof Resolvers];
			if (resolverConfig) {
				// Paranoia uses freedom endpoints, so map it appropriately
				let lookupFamily = getResolverFamily(family);
				if ((resolverConfig as any)[lookupFamily]) {
					let hostname = new URL((resolverConfig as any)[lookupFamily]).hostname;
					if (healthData[hostname] !== undefined) {
						familyHealthScores[hostname] = healthData[hostname];
					}
				}
			}
		}
		
		// Sort by health score descending (best first)
		let sortedScores = Object.entries(familyHealthScores)
			.map(([provider, score]) => ({ provider, health_score: score }))
			.sort((a: any, b: any) => b.health_score - a.health_score);
		
		let resp = {
			family: family,
			last_updated: new Date().toISOString(),
			total_providers: sortedScores.length,
			data: sortedScores
		};
		
		return new Response(JSON.stringify(resp, null, 2), { headers: {'Content-Type': 'application/json'}});
	} catch (e: any) {
		return new Response(JSON.stringify({
			error: 'Failed to retrieve health scores',
			message: e.message
		}), { status: 500, headers: {'Content-Type': 'application/json'}});
	}
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
	family = getResolverFamily(family);

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