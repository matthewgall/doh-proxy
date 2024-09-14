import { Router } from 'itty-router';
import { Buffer } from 'node:buffer';
import { toType, toRcode } from './dnsUtils';
import base64url from 'base64url';
import * as dnsPacket from '@dnsquery/dns-packet';
import Config from '../config.json';
import Resolvers from '../resolvers.json';
import Package from '../package-lock.json';
import Html from '../pages/_resolver.html';

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

async function getDNSResponse(url: any) {
	let p: any = new URL(url).hostname;
	let r: any = await fetch(url, {
		headers: {
			'Content-Type': 'application/dns-message'
		}
	})

	if (r.status !== 200) throw Promise.reject(`Encountered a non 200 response from ${p}`);
	return r;
}

function chooseResolvers(resolvers: any, q: any, family: any = "freedom", n: any = 3) {
	let p = [];
	if (resolvers.length > n) {
		for (let r of resolvers.sampleN(n)) {
			try {
				p.push(getDNSResponse(`${Resolvers[r][family]}?dns=${q}`))
			}
			catch(e: any) {}
		}
	}
	else {
		// Otherwise, pick one
		try {
			p.push(getDNSResponse(`${Resolvers[resolvers.sample()][family]}?dns=${q}`))
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
		if (request.query.type) rrtype = request.query.type.toUpperCase();

		if (name == null) return new Response('Missing name in ?name=', { status: 400 })
	}

	if (!['A', 'AAAA', 'DNSKEY', 'MX', 'NS', 'SRV', 'TXT'].includes(rrtype)) return new Response('Unsupported rrtype', { status: 400 })

	// Next, we need to prepare a query
	let query: any = dnsPacket.encode({
		type: 'query',
		id: getRandomInt(1, 65534),
		flags: dnsPacket.RECURSION_DESIRED,
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

	let providers = chooseResolvers(resolver, query, family);
	
	// And send it off
	let answer: any;
	try {
		answer = await Promise.any(providers);
	}
	catch(e: any) {
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

	// Next, we prepare to send it on, first pick a resolver (by default, we use the default)
	let resolver: any = Config['default'].resolvers
	if (Object.keys(Config).includes(url.hostname)) {
		// Check now for a resolvers set for the hostname the request came in on
		resolver = Config[url.hostname].resolvers
	}

	if (request.method == 'POST') q = base64url(q);

	// We also have to determine the resolver family, by default, freedom
	let family = "freedom"
	if (url.hostname.includes('.mydns.network')) {
		family = url.hostname.split('.')[0];
	}
	if (family == "paranoia") family = "freedom";

	let providers = chooseResolvers(resolver, q, family);
	
	// And send it off
	let answer: any;
	let a: any;
	try {
		answer = await Promise.any(providers);
		a = await answer.arrayBuffer();
	}
	catch(e: any) {
		// So if we get here, something happened, so we'll try and build our own response
		return new Response(`We encountered an error while performing this lookup: ${e}`, { status: 500 });
	}

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

router.get('/', async (request) => {
	// First, we grab the hostname they asked for
	let hostname: any = new URL(request.url).hostname
	let resolver: any = Config['default'].resolvers;
	let url: any = new URL(request.url);
	
	if (Config[hostname]) {
		// Check now for a resolvers set for the hostname the request came in on
		resolver = Config[hostname].resolvers;
	}

	let family = "freedom"
	if (url.hostname.includes('.mydns.network')) {
		family = url.hostname.split('.')[0];
	}
	if (family == "paranoia") family = "freedom";

	// Now to grab the resolver URLs
	let resolvers: any = [];
	for (let r of resolver) {
		if (Resolvers[r][family]) resolvers.push(Resolvers[r][family])
	}

	// This is going to be an amazing hack so I don't have to mess with KV
	let data: any = Html;

	// And now we make some changes to the stored HTML
	data = data.replaceAll('[HOSTNAME]', hostname);
	data = data.replaceAll('[NAME]', hostname.replace('.mydns.network', ''));
	data = data.replaceAll('[RESOLVERS]', resolvers.join('\n'))

	// And craft a new response
	return new Response(data, {
		headers: {
			'Content-Type': 'text/html'
		}
	})
});

router.all("*", () => new Response("404, not found!", { status: 404 }))

export default {
	fetch: router.fetch
}