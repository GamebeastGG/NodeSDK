import { getConfig } from "./config";

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
			["v1/latest/version?platform=roblox"] : "GET",
			["v1/experiments"] : "GET",
			["v1/experiments/assignments"] : "POST",
			["v1/servers/roblox/{serverId}"] : "POST",
			["v1/cohorts/membership"] : "POST"
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
            const { url } = getConfig();

            return {
                url : `${url}${URL_SUFFIX}/${path}`,
                method : currentNode["__METHOD"]
            }
        } else {
            throw new Error(`No matching method found for path: ${path}`);
        }
    };
}

export function makeRequest<T>(path : string, body : object) : Promise<Response<T>> {
    const { apiKey, production } = getConfig();

    const { url, method } = getRequestUrl(path)!;
    return fetch(url, {
        method: method,
        headers: {
            "Content-Type": "application/json",
            "Authorization": `${apiKey}`,
            "isstudio" : production ? "false" : "true",
            //"serverid" : "node-0000", //TODO: Determine what this should be for non-roblox.
            "sdkVersion" : "0.1.0"


        },
        body: JSON.stringify(body)
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