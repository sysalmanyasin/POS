// --- 🔒 PUBLIC WEB INVOCATION ROUTER ---
const ROUTER_P1 = "github_pat_11CE7O4ZI0aQ4pWVoflNdL_";
const ROUTER_P2 = "RFZfK4kPMPUyckWrfw8sWudWcWb5NaD3g7GS9qT8gnrJZXRPSO75NZioAsA";

/**
 * Core line parser to convert CSV input to pristine structured JSON arrays
 */
function parseInventoryCSV(text) {
    const lines = text.split(/\r?\n/);
    if (lines.length === 0 || !lines[0]) return [];
    
    const headers = lines[0].split(',').map(h => h.trim());
    const result = [];
    
    for (let i = 1; i < lines.length; i++) {
        if (!lines[i].trim()) continue;
        const currentLine = lines[i].split(',');
        const obj = {};
        
        headers.forEach((header, index) => {
            let val = currentLine[index] ? currentLine[index].trim() : "";
            if ((header === "Price" || header === "Stock") && !isNaN(val) && val !== "") {
                obj[header] = parseFloat(val);
            } else {
                obj[header] = val;
            }
        });
        result.push(obj);
    }
    return result;
}

/**
 * Fires a secure dispatch webhook trigger to wake up the GitHub Action robot
 */
async function triggerEcosystemSync(csvFileObject) {
    if (!csvFileObject) return alert("Please select a valid CSV file first.");

    // Update status elements on screen if needed
    console.log("Reading CSV target...");

    const reader = new FileReader();
    reader.readAsText(csvFileObject);
    
    reader.onload = async function(event) {
        try {
            const parsedArray = parseInventoryCSV(event.target.result);
            if (parsedArray.length === 0) throw new Error("CSV file contains no valid rows.");

            const dispatchEndpoint = `https://api.github.com/repos/syssalmanyasin/POS/dispatches`;
            const activeToken = ROUTER_P1 + ROUTER_P2;
            
            const response = await fetch(dispatchEndpoint, {
                method: "POST",
                headers: {
                    "Accept": "application/vnd.github+json",
                    "Authorization": `Bearer ${activeToken}`,
                    "Content-Type": "application/json"
                },
                body: JSON.stringify({
                    event_type: "update_inventory",
                    client_payload: {
                        json_data: JSON.stringify(parsedArray, null, 2)
                    }
                })
            });

            if (response.status === 204) {
                alert("🚀 Sync initiated! The GitHub robot is now rebuilding base-inventory.json.");
            } else {
                const errLog = await response.json();
                throw new Error(errLog.message || "Dispatch authentication failed.");
            }

        } catch (err) {
            alert(`Sync Failed: ${err.message}`);
        }
    };
}
