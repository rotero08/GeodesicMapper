import * as d3 from 'd3';
import * as topojson from 'topojson-client';

// Helper function to interpolate between two raw projections
function interpolateProjection(raw0, raw1) {
  const mutate = d3.geoProjectionMutator(t => (x, y) => {
    const [x0, y0] = raw0(x, y);
    const [x1, y1] = raw1(x, y);
    return [x0 + t * (x1 - x0), y0 + t * (y1 - y0)];
  });
  let t = 0;
  return Object.assign(mutate(t), {
    alpha(_) {
      return arguments.length ? mutate(t = +_) : t;
    }
  });
}

// Get canvas and context
const canvas = document.getElementById('globe-canvas');
const toggleButton = document.getElementById('projection-toggle');
const canvasWrapper = document.getElementById('globe-canvas-wrapper');

if (!canvas || !toggleButton || !canvasWrapper) {
    console.error("Required DOM elements (canvas, toggle button, or canvas wrapper) not found!");
} else {
    // --- Dynamic Dimension Calculation ---
    // Calculate dimensions from the *wrapper* to ensure content fits within its bounds
    let width = canvasWrapper.clientWidth;
    let height = canvasWrapper.clientHeight;

    // Maintain a 2:1 aspect ratio for the canvas itself to best suit Mercator.
    // This ensures Mercator map doesn't get squashed or stretched incorrectly by canvas dimensions.
    const idealMercatorAspectRatio = 2; // Width / Height
    if (width / height > idealMercatorAspectRatio) {
        // Wrapper is wider than 2:1, constrain by height
        width = height * idealMercatorAspectRatio;
    } else {
        // Wrapper is taller/narrower than 2:1, constrain by width
        height = width / idealMercatorAspectRatio;
    }

    // Set canvas attributes based on calculated dimensions
    canvas.width = width;
    canvas.height = height;
    const context = canvas.getContext('2d');

    // Define interpolation for rotation and scale
    // Orthographic parameters
    const orthographicRotate = [10, -20, 0];
    const orthographicScale = Math.min(width, height) / 2.5; // Scale to fit the smaller dimension for ortho globe

    // Mercator parameters - we'll use fitSize, but define a placeholder
    const mercatorRotate = [0, 0, 0];
    let mercatorScale; // Will be determined by fitSize
    let mercatorTranslate = [width / 2, height / 2]; // Initial guess, fitSize will adjust

    // Create the interpolated projection
    const projection = interpolateProjection(d3.geoOrthographicRaw, d3.geoMercatorRaw)
        .scale(orthographicScale)
        .translate([width / 2, height / 2])
        .rotate(orthographicRotate)
        .precision(0.1);

    const path = d3.geoPath(projection, context);

    // Define GeoJSON objects
    const equator = {type: "LineString", coordinates: [[-180, 0], [-90, 0], [0, 0], [90, 0], [180, 0]]};
    const sphere = {type: "Sphere"};
    const graticule = d3.geoGraticule10();
    const diagonalLine = {
        type: "LineString",
        coordinates: [[-150, -60], [-75, -30], [0, 0], [75, 30], [150, 60]]
    };

    let countries = null; // Variable to hold countries GeoJSON data

    let animationId = null;
    let isAnimating = false;
    let currentProjectionState = 0; // 0: orthographic, 1: mercator

    // Function to calculate Mercator projection parameters dynamically
    function calculateMercatorParams() {
        const tempMercatorProjection = d3.geoMercator()
            .precision(0.1); // Use a temporary Mercator projection to calculate fit

        // Fit the countries (or sphere) to the available canvas dimensions.
        // Using `sphere` ensures the entire theoretical Mercator map area is considered.
        tempMercatorProjection.fitSize([width, height], sphere); // Fit the entire world sphere

        mercatorScale = tempMercatorProjection.scale();
        mercatorTranslate = tempMercatorProjection.translate();
    }

    /**
     * Renders a single frame of the globe.
     * @param {number} interpolatedT - The interpolation factor (0 to 1) for blending orthographic to mercator.
     * 0 for pure orthographic, 1 for pure mercator.
     */
    function renderFrame(interpolatedT) {
        // Interpolate rotation, scale, and translate
        const interpolatedRotate = d3.interpolate(orthographicRotate, mercatorRotate)(interpolatedT);
        const interpolatedScale = d3.interpolate(orthographicScale, mercatorScale)(interpolatedT);
        const interpolatedTranslate = d3.interpolate([width / 2, height / 2], mercatorTranslate)(interpolatedT); // Interpolate translation too

        // Apply projection parameters
        projection
            .alpha(interpolatedT)
            .rotate(interpolatedRotate)
            .scale(interpolatedScale)
            .translate(interpolatedTranslate); // Apply interpolated translation

        // Clear canvas
        context.clearRect(0, 0, width, height);

        // --- DRAW ORDER: Countries (fill all), then Sphere/Lines (with clipping) ---

        // 1. Draw and fill countries. Set clipAngle based on interpolatedT.
        if (interpolatedT <= 0.5) { // Orthographic part of transition
            const countryClipAngle = 90 + (interpolatedT * 2) * 90;
            projection.clipAngle(countryClipAngle);
        } else { // Mercator part of transition
            projection.clipAngle(null); // No clipping for Mercator countries
        }

        if (countries) {
            context.beginPath();
            path(countries);
            context.fillStyle = "#336699"; // Blue color for countries
            context.fill();
            context.lineWidth = 0.5;
            context.strokeStyle = "#ffffff"; // White borders
            context.stroke();
        }

        // --- Now apply the specific clipping for lines and sphere outline ---
        let lineClipAngle;
        if (interpolatedT <= 0.5) {
            lineClipAngle = 90 + (interpolatedT * 2) * 90;
        } else {
            lineClipAngle = 180; // No clipping for the entire map (Mercator)
        }
        projection.clipAngle(lineClipAngle);


        // Draw graticule
        context.beginPath();
        path(graticule);
        context.lineWidth = 0.5;
        context.strokeStyle = "rgba(255, 255, 255, 0.2)";
        context.stroke();

        // Draw sphere outline (visible in orthographic view, less meaningful in Mercator)
        context.beginPath();
        path(sphere);
        context.lineWidth = 1.5;
        context.strokeStyle = "#fff"; // White outline for sphere
        context.stroke();

        // Draw equator (visibility controlled by clipAngle)
        context.beginPath();
        path(equator);
        context.lineWidth = 2;
        context.strokeStyle = "#ff4444"; // Red line for equator
        context.stroke();

        // Draw the diagonal line
        context.beginPath();
        path(diagonalLine);
        context.lineWidth = 2; // Make it a bit thicker
        context.strokeStyle = "#00FF00"; // Green color for visibility
        context.stroke();
    }

    /**
     * Animates the projection transition.
     * @param {number} targetState - The desired final projection state (0 for ortho, 1 for mercator).
     */
    function animateProjection(targetState) {
        if (isAnimating) return;
        isAnimating = true;
        toggleButton.disabled = true;

        const duration = 1500; // milliseconds
        const ease = d3.easeCubicInOut;
        let startTime = null;

        const startT = currentProjectionState;
        const endT = targetState;

        function loop(currentTime) {
            if (!startTime) startTime = currentTime;
            const elapsed = currentTime - startTime;
            let tProgress = Math.min(1, elapsed / duration);

            const interpolatedFactor = startT + (endT - startT) * ease(tProgress);

            renderFrame(interpolatedFactor);

            if (elapsed < duration) {
                animationId = requestAnimationFrame(loop);
            } else {
                isAnimating = false;
                toggleButton.disabled = false;
                currentProjectionState = targetState;
                renderFrame(targetState);
            }
        }
        animationId = requestAnimationFrame(loop);
    }

    /**
     * Toggles the projection between orthographic and mercator.
     */
    function transformProjection() {
        if (isAnimating) return;

        if (currentProjectionState === 0) { // Currently orthographic, transform to mercator
            animateProjection(1); // Target state is 1 (mercator)
        } else { // Currently mercator, transform back to orthographic
            animateProjection(0); // Target state is 0 (orthographic)
        }
    }

    // --- NEW: Load world data and then initialize the globe ---
    d3.json("https://cdn.jsdelivr.net/npm/world-atlas@2/countries-110m.json").then(world => {
        countries = topojson.feature(world, world.objects.countries);
        console.log("Countries data loaded:", countries);

        // Calculate Mercator parameters AFTER countries data is loaded
        calculateMercatorParams();

        // Initial render after data is loaded
        renderFrame(currentProjectionState);

        // Event listener for the toggle button (moved here to ensure data is ready)
        toggleButton.addEventListener('click', transformProjection);

    }).catch(error => {
        console.error("Error loading the world atlas data:", error);
    });

    // --- Refined Resize Handler ---
    window.addEventListener('resize', () => {
        // Recalculate dimensions based on wrapper
        let newWidth = canvasWrapper.clientWidth;
        let newHeight = canvasWrapper.clientHeight;

        // Apply Mercator aspect ratio constraint to new dimensions
        const idealMercatorAspectRatio = 2;
        if (newWidth / newHeight > idealMercatorAspectRatio) {
            newWidth = newHeight * idealMercatorAspectRatio;
        } else {
            newHeight = newWidth / idealMercatorAspectRatio;
        }

        if (canvas.width !== newWidth || canvas.height !== newHeight) {
            canvas.width = newWidth;
            canvas.height = newHeight;

            // Recalculate Mercator params for new size
            calculateMercatorParams();

            // Update projection translation and scale based on current state and new dimensions
            const newOrthographicScale = Math.min(newWidth, newHeight) / 2.5;
            projection.scale(currentProjectionState === 0 ? newOrthographicScale : mercatorScale);
            projection.translate(currentProjectionState === 0 ? [newWidth / 2, newHeight / 2] : mercatorTranslate);

            // Re-render the current state to adjust for resize
            renderFrame(currentProjectionState);
        }
    });
}
