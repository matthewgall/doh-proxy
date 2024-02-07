import { Router } from 'itty-router';
import { Buffer } from 'node:buffer';
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

function toRcode(code: any) {
	switch (code.toUpperCase()) {
		case 'NOERROR': return 0
		case 'FORMERR': return 1
		case 'SERVFAIL': return 2
		case 'NXDOMAIN': return 3
		case 'NOTIMP': return 4
		case 'REFUSED': return 5
		case 'YXDOMAIN': return 6
		case 'YXRRSET': return 7
		case 'NXRRSET': return 8
		case 'NOTAUTH': return 9
		case 'NOTZONE': return 10
		case 'RCODE_11': return 11
		case 'RCODE_12': return 12
		case 'RCODE_13': return 13
		case 'RCODE_14': return 14
		case 'RCODE_15': return 15
	}
	return 0
}

function toTypes(type: any) {
	switch (type.toUpperCase()) {
		case 'A': return 1
		case 'NULL': return 10
		case 'AAAA': return 28
		case 'AFSDB': return 18
		case 'APL': return 42
		case 'CAA': return 257
		case 'CDNSKEY': return 60
		case 'CDS': return 59
		case 'CERT': return 37
		case 'CNAME': return 5
		case 'DHCID': return 49
		case 'DLV': return 32769
		case 'DNAME': return 39
		case 'DNSKEY': return 48
		case 'DS': return 43
		case 'HIP': return 55
		case 'HINFO': return 13
		case 'IPSECKEY': return 45
		case 'KEY': return 25
		case 'KX': return 36
		case 'LOC': return 29
		case 'MX': return 15
		case 'NAPTR': return 35
		case 'NS': return 2
		case 'NSEC': return 47
		case 'NSEC3': return 50
		case 'NSEC3PARAM': return 51
		case 'PTR': return 12
		case 'RRSIG': return 46
		case 'RP': return 17
		case 'SIG': return 24
		case 'SOA': return 6
		case 'SPF': return 99
		case 'SRV': return 33
		case 'SSHFP': return 44
		case 'TA': return 32768
		case 'TKEY': return 249
		case 'TLSA': return 52
		case 'TSIG': return 250
		case 'TXT': return 16
		case 'AXFR': return 252
		case 'IXFR': return 251
		case 'OPT': return 41
		case 'ANY': return 255
		case '*': return 255
	}
	if (type.toUpperCase().startsWith('UNKNOWN_')) return parseInt(name.slice(8))
	return 0
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

function chooseResolvers(resolvers: any, q: any, n: any = 3) {
	let p = [];
	if (resolvers.length > n) {
		for (let r of resolvers.sampleN(n)) {
			p.push(getDNSResponse(`${Resolvers[r]}?dns=${q}`))
		}
	}
	else {
		// Otherwise, pick one
		p.push(getDNSResponse(`${Resolvers[resolvers.sample()]}?dns=${q}`))
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

	if (!['A', 'AAAA', 'DNSKEY', 'MX', 'SRV', 'TXT'].includes(rrtype)) return new Response('Unsupported rrtype', { status: 400 })

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

	let providers = chooseResolvers(resolver, query);
	
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
			'type': toTypes(q.type)
		})
	};


	// Now, we determine if there is an answer to give
	if (decoded.answers.length > 0) {
		resp.Answer = [];
		for (let ans of decoded.answers) {

			let r: any = {
				'name': `${ans.name}.`,
				'type': toTypes(ans.type),
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
				'type': toTypes(auth.type),
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

	// Now, to validate the payload
	let t: any;
	try {
		t = Buffer.from(q, 'base64');
		t = dnsPacket.decode(t);
	}
	catch(e: any) {
		return new Response('Invalid query', { status: 500 })
	}

	// Next, we prepare to send it on, first pick a resolver (by default, we use the default)
	let resolver: any = Config['default'].resolvers
	if (Object.keys(Config).includes(url.hostname)) {
		// Check now for a resolvers set for the hostname the request came in on
		resolver = Config[url.hostname].resolvers
	}

	if (request.method == 'POST') q = base64url(q);
	let providers = chooseResolvers(resolver, q);
	
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
	
	// Add each provider to the response, so they can be seen
	for (let r of resolver) {
		resp.providers.push(Resolvers[r])
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
	if (Config[hostname]) {
		// Check now for a resolvers set for the hostname the request came in on
		resolver = Config[hostname].resolvers;
	}

	// Now to grab the resolver URLs
	let resolvers: any = [];
	for (let r of resolver) {
		resolvers.push(Resolvers[r])
	}

	// This is going to be an amazing hack so I don't have to mess with KV
	let data: any = await fetch('https://mydns.network/_resolver.html', {
		cf: {
			cacheTtl: 90,
			cacheEverything: true,
		}
	})
	data = await data.text()

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
	fetch: router.handle
}
