import * as d3 from 'd3';
import * as topojson from 'topojson-client';

// Get the canvas wrapper element
const canvasWrapper = d3.select("#globe-canvas-wrapper");
const canvas = d3.select("#globe-canvas");
const context = canvas.node().getContext('2d');

// Declare variables for D3 path generator and projection
let projection;
let path;
let countries;

// --- Projection Interpolation Function ---
function interpolateProjection(raw0, raw1) {
  const mutate = d3.geoProjectionMutator(t => (x, y) => {
    const [x0, y0] = raw0(x, y), [x1, y1] = raw1(x, y);
    return [x0 + t * (x1 - x0), y0 + t * (y1 - y0)];
  });
  let t = 0;
  return Object.assign(mutate(t), {
    alpha(_) {
      return arguments.length ? mutate(t = +_) : t;
    }
  });
}

// --- Great Circle Data ---
const point1 = [-77.0369, 38.9072]; // Washington D.C., USA
const point2 = [151.2093, -33.8688]; // Sydney, Australia

const greatCircleLine = {
  type: "LineString",
  coordinates: [point1, point2]
};

// Calculate the geographic midpoint of the great circle for initial centering
const geoMidpoint = d3.geoInterpolate(point1, point2)(0.5);

// --- Helper function to get current dimensions and setup canvas/projection ---
function updateDimensions() {
  const currentWidth = canvasWrapper.node().clientWidth;
  const currentHeight = canvasWrapper.node().clientHeight;

  // Set canvas dimensions
  canvas
    .attr("width", currentWidth)
    .attr("height", currentHeight);

  // Initialize projection if it doesn't exist
  if (!projection) {
    projection = interpolateProjection(d3.geoOrthographicRaw, d3.geoMercatorRaw)
      .precision(0.1)
      .clipAngle(90); // Start with geometric clipping for a clean orthographic view

    // Load world data
    d3.json("https://cdn.jsdelivr.net/npm/world-atlas@2/countries-110m.json").then(world => {
      countries = topojson.feature(world, world.objects.countries);
      drawGlobe();
    }).catch(error => {
      console.error("Error loading the world atlas data:", error);
    });
  }

  projection.translate([currentWidth / 2, currentHeight / 2]);

  // Create path generator with canvas context
  path = d3.geoPath(projection, context);

  if (countries) {
    drawGlobe();
  }
}

// Define graticule (grid lines for latitude and longitude)
const graticule = d3.geoGraticule10();

// --- Drawing Function ---
function drawGlobe(clipRadius = null) {
  if (!countries) return;

  const currentWidth = canvas.attr("width");
  const currentHeight = canvas.attr("height");

  // Clear canvas
  context.clearRect(0, 0, currentWidth, currentHeight);

  // Save context for clipping
  context.save();

  // Apply circular clipping - USE THE PROVIDED RADIUS IF AVAILABLE
  let radius;
  if (clipRadius !== null) { // <--- This is the key change
    radius = clipRadius;
  } else if (isOrthographic) {
    radius = Math.min(currentWidth, currentHeight) / 2 - 10;
  } else {
    radius = Math.max(currentWidth, currentHeight) * 2; // Very large radius for no clipping
  }

  context.beginPath();
  context.arc(currentWidth / 2, currentHeight / 2, radius, 0, 2 * Math.PI);
  context.clip();

  // Fill background (ocean)
  context.fillStyle = '#000';
  context.fillRect(0, 0, currentWidth, currentHeight);

  // Draw countries
  context.fillStyle = '#008080';
  context.strokeStyle = '#006666';
  context.lineWidth = 0.5;

  countries.features.forEach(feature => {
    context.beginPath();
    path(feature);
    context.fill();
    context.stroke();
  });

  // Draw graticule
  context.strokeStyle = 'rgba(255, 255, 255, 0.2)';
  context.lineWidth = 0.5;
  context.beginPath();
  path(graticule);
  context.stroke();

  // Draw great circle
  context.strokeStyle = '#ff4444';
  context.lineWidth = 2;
  context.beginPath();
  path(greatCircleLine);
  context.stroke();

  // Restore context
  context.restore();
}

// --- Animation Logic ---
let isOrthographic = true;

function toggleProjection() {
  const transitionDuration = 3000;
  const currentWidth = +canvas.attr("width");
  const currentHeight = +canvas.attr("height");

  // --- States ---
  const orthographicState = {
    rotation: [-geoMidpoint[0], -geoMidpoint[1], 0],
    scale: Math.min(currentWidth, currentHeight) / 2 - 10,
    clipRadius: Math.min(currentWidth, currentHeight) / 2 - 10
  };

  const mercatorState = {
    rotation: [0, 0, 0],
    scale: Math.min((currentWidth - 2) / (2 * Math.PI), (currentHeight - 2) / Math.PI),
    clipRadius: Math.max(currentWidth, currentHeight) * 1.5 // Large enough to show everything
  };

  const startState = isOrthographic ? orthographicState : mercatorState;
  const endState = isOrthographic ? mercatorState : orthographicState;

  // Create interpolators
  const scaleInterpolator = d3.interpolate(startState.scale, endState.scale);
  const rotateInterpolator = d3.interpolate(startState.rotation, endState.rotation);
  const clipRadiusInterpolator = d3.interpolate(startState.clipRadius, endState.clipRadius);

  const button = document.getElementById('projection-toggle');
  button.disabled = true;

  // Remove D3's geometric clipping during transition
  // This is important so that the canvas clipping can take full control
  projection.clipAngle(null);

  d3.transition()
    .duration(transitionDuration)
    .ease(d3.easeCubic)
    .tween("projectionTransform", () => {
      const i = d3.interpolate(0, 1);
      return t => {
        const alpha = isOrthographic ? i(t) : 1 - i(t);
        projection.alpha(alpha);
        projection.scale(scaleInterpolator(t));
        projection.rotate(rotateInterpolator(t));

        // Use interpolated clip radius for smooth transition
        const currentClipRadius = clipRadiusInterpolator(t);
        drawGlobe(currentClipRadius); // Pass the interpolated clipRadius
      };
    })
    .on("end", () => {
      isOrthographic = !isOrthographic;

      // Set final projection clipping state
      if (isOrthographic) {
        projection.clipAngle(90);
      } else {
        projection.clipAngle(null);
      }

      drawGlobe();
      button.disabled = false;
    });
}

// --- Initial setup and resize listener ---
updateDimensions();
window.addEventListener('resize', updateDimensions);

// --- Add Basic Interaction (Dragging to Rotate) ---
let rotating = false;
let v0, r0;

canvasWrapper.on("mousedown", function(event) {
  d3.interrupt(d3.select("body").node()); // Interrupts any ongoing transition
  rotating = true;
  v0 = [event.clientX, event.clientY];
  r0 = projection.rotate();
});

canvasWrapper.on("mousemove", function(event) {
  if (rotating) {
    const v1 = [event.clientX, event.clientY];
    const dr = [(v1[0] - v0[0]) * 0.2, -(v1[1] - v0[1]) * 0.2];
    const r1 = [r0[0] + dr[0], r0[1] + dr[1]];

    r1[1] = Math.max(-90, Math.min(90, r1[1]));

    projection.rotate(r1);
    drawGlobe();
  }
});

canvasWrapper.on("mouseup", function() {
  rotating = false;
});

canvasWrapper.on("mouseleave", function() {
  rotating = false;
});

document.getElementById('projection-toggle').addEventListener('click', toggleProjection);
