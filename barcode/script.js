function generateBarcode() {
    const input = document.getElementById('barcodeInput').value;
    
    if (!input) {
        alert('Please enter a number');
        return;
    }

    if (!/^\d+$/.test(input)) {
        alert('Please enter only numbers');
        return;
    }

    try {
        JsBarcode("#barcode", input, {
            format: "CODE128",
            width: 2,
            height: 100,
            displayValue: true,
            fontSize: 20,
            margin: 10
        });
    } catch (error) {
        alert('Error generating barcode. Please try again.');
    }
}

// Add event listener for Enter key
document.getElementById('barcodeInput').addEventListener('keypress', function(event) {
    if (event.key === 'Enter') {
        generateBarcode();
    }
});

// Function to get URL parameters
function getUrlParameter(name) {
    const urlParams = new URLSearchParams(window.location.search);
    return urlParams.get(name);
}

// Check for number parameter on page load
window.addEventListener('load', function() {
    const numberParam = getUrlParameter('number');
    if (numberParam) {
        document.getElementById('barcodeInput').value = numberParam;
        generateBarcode();
    }
}); 
