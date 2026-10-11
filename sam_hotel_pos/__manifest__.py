{
    'name': "HOTELI POA POS",
    'summary': "Point of Sale for Food, Beverages and Equipment — HOTELI POA",
    'description': """
        HOTELI POA Point of Sale
        =========================
        - Food, Beverages and Equipment
        - Custom POS for hotel restaurant
        - Blue/white theme
        - USD pricing
    """,
    'author': "HOTELI POA Dev Team",
    'category': 'Sales/Point of Sale',
    'version': '17.0.1.0.0',
    'license': 'LGPL-3',
    'depends': ['base', 'product', 'web'],
    'data': [
        'security/sam_hotel_security.xml',
        'security/ir.model.access.csv',
        'views/category_views.xml',
        'views/product_views.xml',
        'views/order_views.xml',
        'views/menus.xml',
        'data/demo_data.xml',
        'data/sequence.xml',
    ],
    'installable': True,
    'application': True,
    'auto_install': False,
}
