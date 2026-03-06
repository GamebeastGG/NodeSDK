import { getSdkConfig } from "./config";

type Methods = "GET" | "POST" | "PUT" | "DELETE";

type Endpoint = {
    Requests : {
        [route : string] : Methods
    },
    EndpointTree : any
}

type Response<T> = { 
    ok : boolean,
    status : number,
    data : T
}


const URL_SUFFIX = "/sdk"
const ENDPOINTS : Endpoint[] = [
	{ 
		Requests : { // NOTE: If you require URL parameters, use {param} in the route string. Example: "v1/servers/roblox/{serverId}"
			["v1/markers"] : "POST",
			["v1/requests"] : "GET",
			["v1/requests/completed"] : "POST",
			["v1/requests/started"] : "PUT",
			["v1/configurations"] : "GET",
			["v1/experiments"] : "GET",
			["v1/experiments/assignments"] : "POST",
			["v1/servers/roblox/{serverId}"] : "POST",
			["v1/cohorts/membership"] : "POST",
            // Temporary endpoint for testing config updates. Remove in future.
            ["v2/configs/{configName}"] : "GET",
            ["v2/status"] : "GET",
            ["v2/experiments/assignment"] : "GET"
		},
		EndpointTree : {} // Automatically generated from above
	}
];

function getRequestUrl(path : string) : { url : string, method : Methods } | undefined {

    const parts = path.split("/");

    for (const endpoint of ENDPOINTS) {
        let currentNode = endpoint.EndpointTree;
        for (const part of parts) {
            if (currentNode[part]) {
                currentNode = currentNode[part];
            } else if (currentNode["__PARAM"]) {
                currentNode = currentNode["__PARAM"];
            } else {
                throw new Error(`No matching endpoint found for path: ${path}`);
            }
        }
        if (currentNode["__METHOD"]) {
            const { url } = getSdkConfig();

            return {
                url : `${url}${URL_SUFFIX}/${path}`,
                method : currentNode["__METHOD"]
            }
        } else {
            throw new Error(`No matching method found for path: ${path}`);
        }
    };
}

function makeSearchParams(params : object) {
    const paramsArray : {k : string, v : any}[] = [];
    for (const [key, value] of Object.entries(params)) {
        if (value === undefined) {
            continue;
        }

        if (Array.isArray(value)) {
            value.forEach(val => {
                paramsArray.push({ k: key, v: val });
            });
        } else {
            paramsArray.push({ k: key, v: value });
        }
    }

    const paramsString = paramsArray.map(({ k, v }) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`).join("&");
    return paramsString;
}


export function makeRequest<T>(path : string, body : object = {}) : Promise<Response<T>> {
    const { apiKey, production } = getSdkConfig();

    let { url, method } = getRequestUrl(path)!;

    if (method == "GET") {
        if (Object.keys(body).length > 0) {
            url += "?" + makeSearchParams(body);
        }
    } 

    console.log(`Making request to ${url} with method ${method} and body`, body);
    return fetch(url, {
        method: method,
        headers: {
            "Content-Type": "application/json",
            "Authorization": `${apiKey}`,
            "isstudio" : production ? "false" : "true",
            //"serverid" : "node-0000", //TODO: Determine what this should be for non-roblox.
            "sdkVersion" : "0.1.0"
        },
        body: method !== "GET" ? JSON.stringify(body) : undefined
    }).then(async (response) => {
        let data = await response.json() as T;

        return {
            ok : response.ok,
            status : response.status,
            data
        }
    });
};

{ // Generate EndpointTree for each endpoint based on its Requests
    ENDPOINTS.forEach(endpoint => {
        const endpointTree : any = {};
        for (const route in endpoint.Requests) {
            const parts = route.split("/");
            let currentNode = endpointTree;
            for (const part of parts) {
                const isPartParam = part.startsWith("{") && part.endsWith("}");
                if (!currentNode[part]) {
                    if (isPartParam) {
                        currentNode["__PARAM"] = {};
                    } else {
                        currentNode[part] = {};
                    }
                }

                currentNode = isPartParam ? currentNode["__PARAM"] : currentNode[part];
            }
            currentNode["__METHOD"] = endpoint.Requests[route];
        }
        endpoint.EndpointTree = endpointTree;
    });
}