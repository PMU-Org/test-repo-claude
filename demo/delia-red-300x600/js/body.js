globalHTML5Api.on("load", function () {
	function $(id) {
		return document.getElementById(id);
	}
	$("container").onclick = function (_event) {
		globalHTML5Api.click();
	};
	document.body.onselectstart = function () {
		return false;
	};
	globalHTML5Api.init({
		'resize': [
		{
			'name': 'state-1',
			'width': '300px',
			'height': '600px'
		}
		]
	});
	startBanner();
});
